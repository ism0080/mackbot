/**
 * hark — the user's phone, reached through Hark, by the harness rather than
 * the model.
 *
 * A pending approval and a parked task are both a bot waiting on a human, and
 * nobody sees them unless the web app is open: a cron-run bot would wait
 * forever. So the harness reaches the user through Hark, installed in Executor
 * as an app from its MCP server, with direct Executor `call`s that the model
 * never sees and cannot skip.
 *
 * A pending approval becomes an approval prompt on the phone
 * (`interactions_create`). Hark's MCP tools offer no callback, so the answer
 * is polled (`interactions_get`) by the approval's own durable wait, which
 * already wakes every 30 seconds until the approval is decided or expires: an
 * answer from the phone then takes the same decision path as the web app's.
 * Only a person can answer a Hark prompt; an agent token has no route to. An
 * approval decided in the app, or expired, withdraws its prompt
 * (`interactions_cancel`) so the phone does not keep a stale question. A
 * parked task is a plain push (`notify`).
 *
 * Every call here is a side channel. It runs behind the path that triggered
 * it and every failure is a log line, so it can never break, delay or fail an
 * approval, a decision or a park. Executor may gate a Hark tool for approval;
 * a paused call is dropped and logged, never recorded as an approval, because
 * an approval would prompt the phone again and loop. Hark's tools must
 * therefore be set to never require approval in Executor.
 *
 * Each prompt or push is sent at most once: a durable marker keyed on the
 * approval or the parked task is claimed before the call, so a Durable Object
 * that restarts does not notify twice, and Hark's own idempotency key covers a
 * call retried in flight. A retried task forgets its marker, so the same task
 * parking again is news again.
 *
 * Executor's app tools take `{ accountId, input }`. The account is the Hark
 * account linked in Executor, read from the tool's signature with one
 * `describe` the first time it is needed, so nothing has to be configured.
 */

import { Cause, Effect, Option, Predicate, Schema } from "effect";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ApprovalDecision } from "@mackbot/contract";

import { describeCause } from "./errors.ts";
import type { ExecutorToolClient, ExecutorToolValue, McpToolArguments } from "./executor-mcp.ts";
import { read, write } from "./sql.ts";
import type { SqlExecutor, SqlStorage } from "./sql.ts";
import { currentTimeMillis } from "./clock.ts";

/** Where the Hark app's tools live in Executor when it is installed as `hark`. */
export const DEFAULT_HARK_TOOLS = "tools.hark";

/** The `HARK_TOOLS` value that turns the phone channel off. */
export const HARK_OFF = "off";

/** The inbox project every mackbot push is filed under. */
export const HARK_PROJECT = "mackbot";

/** How long a marker is kept before {@link HarkNotifier.prune} drops it. */
export const HARK_MARKER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Hark keeps a prompt answerable for at most a day. */
const MAX_PROMPT_EXPIRY_SECONDS = 86_400;
const MIN_PROMPT_EXPIRY_SECONDS = 30;

/**
 * While a prompt is fresh the answer is read on every wake of the wait; after
 * that it is read every five minutes, so a day-long approval nobody answers
 * costs a few hundred Executor calls rather than thousands.
 */
const FRESH_PROMPT_MS = 15 * 60 * 1000;
const STALE_POLL_MS = 5 * 60 * 1000;

// Hark's own limits on the fields.
const MAX_TITLE = 80;
const MAX_SUMMARY = 500;
const MAX_BODY = 8000;
const MAX_PROMPT = 2000;
const MAX_IDEMPOTENCY_KEY = 200;

/** The Executor paths of the Hark tools mackbot calls. */
export interface HarkTools {
  readonly notify: string;
  readonly ask: string;
  readonly answer: string;
  readonly cancel: string;
}

/**
 * The Hark tools a deployment calls: under `tools.hark` when the variable is
 * unset or blank, under the namespace it names otherwise, and none when it is
 * `off`.
 */
export const harkToolsOf = (configured: string | undefined): HarkTools | undefined => {
  const trimmed = configured?.trim() ?? "";
  if (trimmed.toLowerCase() === HARK_OFF) return undefined;
  const namespace = trimmed === "" ? DEFAULT_HARK_TOOLS : trimmed.replace(/\.+$/u, "");
  return {
    notify: `${namespace}.notify`,
    ask: `${namespace}.interactions_create`,
    answer: `${namespace}.interactions_get`,
    cancel: `${namespace}.interactions_cancel`,
  };
};

const bounded = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const parseUrl = Option.liftThrowable((text: string) => new URL(text));

/**
 * The web app's screen for one bot: its transcript, where its pending
 * approvals and its retry controls are. Hark only opens https links, so
 * without a public https origin there is no link.
 */
export const botDeepLink = (publicUrl: string | undefined, bot: string): string | undefined =>
  Option.getOrUndefined(
    Option.map(
      Option.filter(parseUrl(publicUrl?.trim() ?? ""), (url) => url.protocol === "https:"),
      (url) => `${url.origin}/chat/${encodeURIComponent(bot)}`,
    ),
  );

export const approvalPromptKey = (approvalId: string): string => `approval:${approvalId}`;

export const parkedNotificationKey = (taskId: string): string => `parked:${taskId}`;

/** A one-way push. */
export interface HarkNotification {
  /** Durable dedup key, e.g. `parked:<taskId>`. */
  readonly key: string;
  readonly bot: string;
  readonly title: string;
  readonly body: string;
  readonly summary: string;
  readonly url?: string;
}

/** An Approve/Deny question on the phone for one pending approval. */
export interface HarkApprovalPrompt {
  readonly key: string;
  readonly bot: string;
  readonly approvalId: string;
  readonly title: string;
  readonly prompt: string;
  readonly url?: string;
  readonly expiresInSeconds: number;
}

/** The push for a task the crash-loop guard parked. */
export const parkedTaskNotification = (parked: {
  readonly bot: string;
  readonly taskId: string;
  readonly taskKind?: string;
  readonly detail?: string;
  readonly publicUrl?: string;
}): HarkNotification => ({
  key: parkedNotificationKey(parked.taskId),
  bot: parked.bot,
  title: parked.bot,
  summary: `${parked.bot} stopped: task parked, retry from the app`,
  body: [
    `${parked.bot} stopped: task ${parked.taskId}${parked.taskKind === undefined ? "" : ` (${parked.taskKind})`} was cut off too many times and is parked.`,
    ...(parked.detail === undefined ? [] : [`Last failure: ${parked.detail}`]),
    "Retry it from the mackbot app.",
  ].join("\n\n"),
  url: botDeepLink(parked.publicUrl, parked.bot),
});

/**
 * The question for a pending approval: which tool, what the approval says,
 * and the draft the call would carry out, cut to fit Hark's prompt. The
 * prompt expires with the approval's own wait, so the phone never offers a
 * decision nothing is waiting for.
 */
export const approvalPrompt = (approval: {
  readonly bot: string;
  readonly approvalId: string;
  readonly toolPath: string;
  readonly summary: string;
  readonly draft?: string;
  readonly deadline: number;
  readonly now: number;
  readonly publicUrl?: string;
}): HarkApprovalPrompt => {
  const head = `${approval.toolPath}\n\n${approval.summary}`;
  const prompt =
    approval.draft === undefined ? head : bounded(`${head}\n\n${approval.draft}`, MAX_PROMPT);
  const seconds = Math.floor((approval.deadline - approval.now) / 1000);
  return {
    key: approvalPromptKey(approval.approvalId),
    bot: approval.bot,
    approvalId: approval.approvalId,
    title: bounded(approval.bot, MAX_TITLE),
    prompt: bounded(prompt, MAX_PROMPT),
    url: botDeepLink(approval.publicUrl, approval.bot),
    expiresInSeconds: Math.min(
      MAX_PROMPT_EXPIRY_SECONDS,
      Math.max(MIN_PROMPT_EXPIRY_SECONDS, seconds),
    ),
  };
};

/**
 * Hark's idempotency key for one claim. It carries the bot and the moment the
 * marker was claimed, so a task that parks again after a retry is a new push
 * rather than a replay of the first.
 */
const idempotencyKeyOf = (bot: string, key: string, claimedAt: number): string =>
  bounded(`mackbot:${bot}:${key}:${claimedAt}`, MAX_IDEMPOTENCY_KEY);

/** The notify tool's input for one push. */
export const harkNotifyInput = (
  notification: HarkNotification,
  claimedAt: number,
): McpToolArguments => {
  const input: McpToolArguments = {
    idempotencyKey: idempotencyKeyOf(notification.bot, notification.key, claimedAt),
    title: bounded(notification.title, MAX_TITLE),
    summary: bounded(notification.summary, MAX_SUMMARY),
    body: bounded(notification.body, MAX_BODY),
    project: HARK_PROJECT,
  };
  if (notification.url !== undefined) input.url = notification.url;
  return input;
};

/** The interactions tool's input for one approval prompt. */
export const harkPromptInput = (
  prompt: HarkApprovalPrompt,
  claimedAt: number,
): McpToolArguments => {
  const input: McpToolArguments = {
    idempotencyKey: idempotencyKeyOf(prompt.bot, prompt.key, claimedAt),
    kind: "approval",
    title: prompt.title,
    prompt: prompt.prompt,
    expiresInSeconds: prompt.expiresInSeconds,
  };
  if (prompt.url !== undefined) input.url = prompt.url;
  return input;
};

const DescribedSchema = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ path: Schema.String, signature: Schema.optional(Schema.String) }),
  ),
});

const ACCOUNT_ID_PATTERN = /accountId:\s*"([^"]+)"/u;

/**
 * The account a tool's Executor signature pins, e.g. `accountId: "acc_…"`, or
 * `undefined` when the signature names none.
 */
export const accountIdOf = (described: CallToolResult, path: string): string | undefined =>
  Option.getOrUndefined(
    Option.flatMap(
      Schema.decodeUnknownOption(DescribedSchema)(described.structuredContent),
      (decoded) =>
        Option.fromNullishOr(
          ACCOUNT_ID_PATTERN.exec(
            decoded.items.find((item) => item.path === path)?.signature ?? "",
          )?.[1],
        ),
    ),
  );

const InteractionStatusSchema = Schema.Literals([
  "pending",
  "approved",
  "denied",
  "yes",
  "no",
  "replied",
  "canceled",
  "expired",
]);

export type HarkInteractionStatus = typeof InteractionStatusSchema.Type;

const InteractionFromText = Schema.fromJsonString(
  Schema.Struct({
    interaction: Schema.Struct({ id: Schema.String, status: InteractionStatusSchema }),
  }),
);

/**
 * The interaction a Hark tool answered with. Hark puts a warning about
 * untrusted text ahead of the JSON in some answers, so every text item is
 * tried and the first that is an interaction wins.
 */
export const interactionOf = (
  value: ExecutorToolValue | undefined,
): { readonly id: string; readonly status: HarkInteractionStatus } | undefined =>
  Option.getOrUndefined(
    Option.firstSomeOf(
      (value?.content ?? []).map((item) =>
        Option.map(
          Schema.decodeUnknownOption(InteractionFromText)(item.text ?? ""),
          (decoded) => decoded.interaction,
        ),
      ),
    ),
  );

/** The decision a phone answer is, or `undefined` for one that decides nothing. */
export const decisionOfAnswer = (status: HarkInteractionStatus): ApprovalDecision | undefined => {
  if (status === "approved") return { action: "allow" };
  if (status === "denied") return { action: "deny" };
  return undefined;
};

/** What one attempt to reach the phone did; the tests read it, the host ignores it. */
export type HarkDelivery = "disabled" | "duplicate" | "sent" | "paused" | "failed";

export type HarkNotifier = {
  /** Push one notification at most once. Never rejects. */
  readonly notify: (notification: HarkNotification) => Promise<HarkDelivery>;
  /** Put one approval to the phone at most once. Never rejects. */
  readonly ask: (prompt: HarkApprovalPrompt) => Promise<HarkDelivery>;
  /**
   * The phone's answer to an approval's prompt, or `undefined` while there is
   * none, or none to read. Throttled, so the wait can call it on every wake.
   * Never rejects.
   */
  readonly answerOf: (approvalId: string) => Promise<ApprovalDecision | undefined>;
  /** Withdraw an approval's prompt the phone has not answered. Never rejects. */
  readonly withdraw: (approvalId: string) => Promise<void>;
  /** Forget a marker, so the same key notifies again. */
  readonly forget: (key: string) => void;
  /** Drop markers older than `olderThanMs` (default {@link HARK_MARKER_RETENTION_MS}). */
  readonly prune: (olderThanMs?: number) => void;
};

export interface HarkNotifierOptions {
  /** The Hark tools to call; `undefined` turns the channel off. */
  readonly tools: HarkTools | undefined;
  readonly executor: ExecutorToolClient;
  readonly storage: SqlStorage;
  /** Called once Hark accepted a push or a prompt, e.g. to audit it. */
  readonly onSent?: (sent: { readonly key: string; readonly bot: string }) => void;
  readonly now?: () => number;
}

const CREATE_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS mackbot_notifications (key TEXT PRIMARY KEY, sent_at INTEGER NOT NULL, interaction_id TEXT, checked_at INTEGER, settled INTEGER NOT NULL DEFAULT 0)";

// The claim: a row only the first attempt can insert.
const CLAIM_SQL =
  "INSERT INTO mackbot_notifications (key, sent_at) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING key";

const RECORD_INTERACTION_SQL = "UPDATE mackbot_notifications SET interaction_id = ? WHERE key = ?";

const OPEN_PROMPT_SQL =
  "SELECT interaction_id, sent_at, checked_at FROM mackbot_notifications WHERE key = ? AND settled = 0 AND interaction_id IS NOT NULL";

const CHECKED_SQL = "UPDATE mackbot_notifications SET checked_at = ? WHERE key = ?";

// Guarded on `settled = 0`, so only one caller settles a prompt.
const SETTLE_SQL =
  "UPDATE mackbot_notifications SET settled = 1 WHERE key = ? AND settled = 0 RETURNING interaction_id";

const FORGET_SQL = "DELETE FROM mackbot_notifications WHERE key = ?";

const PRUNE_SQL = "DELETE FROM mackbot_notifications WHERE sent_at < ?";

const OpenPromptSchema = Schema.Struct({
  interaction_id: Schema.String,
  sent_at: Schema.Number,
  checked_at: Schema.NullOr(Schema.Number),
});

/** Whether a prompt is due for another look at its answer. */
const answerDue = (prompt: typeof OpenPromptSchema.Type, now: number): boolean => {
  if (prompt.checked_at === null) return true;
  if (now - prompt.sent_at < FRESH_PROMPT_MS) return true;
  return now - prompt.checked_at >= STALE_POLL_MS;
};

export const createHarkNotifier = (options: HarkNotifierOptions): HarkNotifier => {
  const executor: SqlExecutor = options.storage.sql;
  const now = options.now ?? currentTimeMillis;
  const tools = options.tools;
  let migrated = false;
  // The linked account, read once per isolate; a failed read is not kept.
  let account: Option.Option<string | undefined> = Option.none();

  const ensureMigrated = (): void => {
    if (migrated) return;
    write(executor, CREATE_TABLE_SQL);
    migrated = true;
  };

  const claim = (key: string, at: number): boolean => {
    ensureMigrated();
    return read(executor, CLAIM_SQL, key, at).length > 0;
  };

  const settle = (key: string): string | undefined => {
    ensureMigrated();
    const id = read(executor, SETTLE_SQL, key)[0]?.interaction_id;
    return Predicate.isString(id) ? id : undefined;
  };

  const openPrompt = (key: string) => {
    ensureMigrated();
    return Option.getOrUndefined(
      Schema.decodeUnknownOption(OpenPromptSchema)(read(executor, OPEN_PROMPT_SQL, key)[0]),
    );
  };

  const accountFor = (path: string): Effect.Effect<string | undefined, string> =>
    Option.match(account, {
      onSome: Effect.succeed,
      onNone: () =>
        Effect.map(options.executor.describe([path]), (described) => {
          const found = accountIdOf(described, path);
          account = Option.some(found);
          return found;
        }),
    });

  /**
   * One call to a Hark tool. A call that paused or failed is logged here, so
   * the caller only has to stop.
   */
  const callHark = (path: string, input: McpToolArguments, about: string) =>
    Effect.gen(function* () {
      const accountId = yield* accountFor(path);
      const outcome = yield* options.executor.call(
        path,
        accountId === undefined ? { input } : { accountId, input },
      );
      if (outcome.kind === "paused") {
        console.error(
          `mackbot: Executor paused the Hark call ${path} (${about}) for approval; it was dropped. Set ${path} to never require approval in Executor.`,
        );
      }
      if (outcome.kind === "failed") {
        console.error(`mackbot: the Hark call ${path} (${about}) failed: ${outcome.detail}`);
      }
      return outcome;
    });

  /** Run one side-channel step: a failure of any kind is a log line and `fallback`. */
  const quietly = <A>(about: string, fallback: A, effect: Effect.Effect<A, unknown>): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            console.error(
              `mackbot: the Hark call (${about}) failed: ${describeCause(Cause.squash(cause))}`,
            );
            return fallback;
          }),
        ),
      ),
    );

  const notify = (notification: HarkNotification): Promise<HarkDelivery> => {
    if (tools === undefined) return Promise.resolve("disabled");
    const about = `${notification.key} for "${notification.bot}"`;
    return quietly(
      about,
      "failed",
      Effect.gen(function* () {
        const claimedAt = now();
        if (!claim(notification.key, claimedAt)) return "duplicate" as const;
        const outcome = yield* callHark(
          tools.notify,
          harkNotifyInput(notification, claimedAt),
          about,
        );
        if (outcome.kind !== "completed") return outcome.kind;
        options.onSent?.({ key: notification.key, bot: notification.bot });
        return "sent" as const;
      }),
    );
  };

  const ask = (prompt: HarkApprovalPrompt): Promise<HarkDelivery> => {
    if (tools === undefined) return Promise.resolve("disabled");
    const about = `${prompt.key} for "${prompt.bot}"`;
    return quietly(
      about,
      "failed",
      Effect.gen(function* () {
        const claimedAt = now();
        if (!claim(prompt.key, claimedAt)) return "duplicate" as const;
        const outcome = yield* callHark(tools.ask, harkPromptInput(prompt, claimedAt), about);
        if (outcome.kind !== "completed") return outcome.kind;
        const interaction = interactionOf(outcome.value);
        if (interaction === undefined) {
          console.error(
            `mackbot: Hark accepted the prompt ${about} but named no interaction; its answer cannot be read.`,
          );
          return "failed" as const;
        }
        write(executor, RECORD_INTERACTION_SQL, interaction.id, prompt.key);
        options.onSent?.({ key: prompt.key, bot: prompt.bot });
        return "sent" as const;
      }),
    );
  };

  const answerOf = (approvalId: string): Promise<ApprovalDecision | undefined> => {
    if (tools === undefined) return Promise.resolve(undefined);
    const key = approvalPromptKey(approvalId);
    return quietly(
      key,
      undefined,
      Effect.gen(function* () {
        const prompt = openPrompt(key);
        const at = now();
        if (prompt === undefined || !answerDue(prompt, at)) return undefined;
        write(executor, CHECKED_SQL, at, key);
        const outcome = yield* callHark(tools.answer, { id: prompt.interaction_id }, key);
        if (outcome.kind !== "completed") return undefined;
        const status = interactionOf(outcome.value)?.status;
        if (status === undefined || status === "pending") return undefined;
        // Answered, expired or withdrawn: there is nothing more to read.
        settle(key);
        return decisionOfAnswer(status);
      }),
    );
  };

  const withdraw = (approvalId: string): Promise<void> => {
    if (tools === undefined) return Promise.resolve();
    const key = approvalPromptKey(approvalId);
    return quietly(
      key,
      undefined,
      Effect.gen(function* () {
        const id = settle(key);
        if (id === undefined) return;
        yield* callHark(tools.cancel, { id }, key);
      }),
    );
  };

  const forget = (key: string): void => {
    ensureMigrated();
    write(executor, FORGET_SQL, key);
  };

  const prune = (olderThanMs: number = HARK_MARKER_RETENTION_MS): void => {
    ensureMigrated();
    write(executor, PRUNE_SQL, now() - olderThanMs);
  };

  return { notify, ask, answerOf, withdraw, forget, prune };
};
