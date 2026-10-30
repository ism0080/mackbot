/**
 * approvals — the `mackbot_approvals` table, the path from a decision to a
 * resumed call, and the durable wait that keeps a decision from being lost.
 *
 * The executor bridge detects a paused call and records it here through
 * {@link ApprovalStore.recordPaused}. Recording is idempotent on Executor's
 * `requestId`, so one paused call is one row however many times the bridge
 * observes it. The triage home then reads every bot's pending approvals through
 * `/status`, because the home screen has to know what is blocked before it
 * subscribes to anything. A bot holds at most {@link MAX_PENDING_APPROVALS}
 * pending approvals, so a run that pauses over and over cannot fill the table
 * or start a wait for every pause.
 *
 * A decision is durable first and a submission second. The steer is the only
 * thing that turns a decision into a submission, and it goes through the
 * harness so the model calls `executor_resume` itself: the resume is a pi tool
 * with unsafe replay, and a resume the transcript never records would authorize
 * an effect nobody can audit. The row keeps the whole decision, form content
 * included, so every delivery carries what the human said and the executor
 * policy can hold the resume to it.
 *
 * Two steps are two chances to lose the second one. A Durable Object that
 * dies between the decision and the steer leaves a decided approval and a
 * paused call nobody resumes: the human's answer is on record and the call
 * waits forever. There are two recoveries. A decision is idempotent, so the
 * human (or the browser) repeating the same decision delivers the steer again
 * instead of being told the approval is gone. And {@link createApprovalWait}
 * builds a durable task that polls for the decision and submits the HTTP
 * path's own steer under the same operation id, so pi's request-id idempotency
 * joins the second submission to the first instead of starting a second run.
 *
 * The wait carries the store it delivers through, because a task must continue
 * from its committed state alone: after a restart the Harness resumes the task
 * before any route has asked the bot for its approvals, so a wait that looked
 * its store up in module scope would find none and poll until its deadline.
 *
 * An approval nobody decides before the wait's deadline is `expired`: the wait
 * marks it when it gives up, and every read marks the ones whose deadline has
 * passed, so a lost wait cannot leave a row pending forever.
 *
 * The same wait also asks the host whether the human answered on another
 * channel (their phone, through Hark) while the approval is pending, and an
 * answer is decided through {@link ApprovalStore.decide}, the route's own
 * path, recorded with the channel it came by. The host hears when an approval
 * is recorded and when it stops being pending, so it can put the question to
 * the phone and withdraw it again.
 *
 * Each step of that life (requested, limited, decided, redelivered, delivered,
 * resumed, expired) is reported to the host's audit sink as it happens.
 *
 * `request_id` and `session_id` are Executor's and pi's, and stay here. The
 * `ApprovalView` the browser sees is this module's projection of the row, and
 * it carries neither.
 */

import { Effect, Option, Schema } from "effect";
import type { PiWhenBusy } from "agents/harness/pi";
import { defineExtension, defineTask } from "@earendil-works/pi-durable";
import type { Extension, NextTaskState, Task } from "@earendil-works/pi-durable";

import { sameApprovalContent } from "./executor-policy.ts";
import type { ApprovalStatus } from "./executor-policy.ts";
import { approvalOperationId, pausedCallAuditId } from "./operation.ts";
import type { AuditSink } from "./audit-log.ts";
import { describeCause } from "./errors.ts";
import { toJson, toPrettyJson } from "./json.ts";
import { read, write } from "./sql.ts";
import type { SqlExecutor, SqlRow, SqlStorage, SqlValue } from "./sql.ts";
import { ApprovalDecisionSchema, ApprovalViewSchema, originOf } from "@mackbot/contract";
import type { ApprovalDecision, ApprovalView, DecisionAccepted } from "@mackbot/contract";
import { currentTimeMillis } from "./clock.ts";

/**
 * How many approvals one bot may have waiting at once. Each one is a row the
 * home screen shows and a wait that polls, so a model that keeps pausing calls
 * is stopped here rather than by the table's size.
 */
export const MAX_PENDING_APPROVALS = 20;

/** How long a decided or expired approval is kept before {@link ApprovalStore.prune} drops it. */
export const APPROVAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long the wait sleeps between two looks at the approval. Short enough
 * that a human who pressed the button sees the effect at once, long enough
 * that a bot nobody answers does not churn.
 */
const WAIT_POLL_MS = 30_000;

/**
 * How long an approval waits for a human. A day is long enough that a human
 * who comes back to an approval still finds the wait alive; after that the
 * approval is expired, and nothing can decide it any more.
 */
export const WAIT_DEADLINE_MS = 24 * 60 * 60 * 1000;

const ArtifactSchema = Schema.fromJsonString(
  Schema.Struct({ label: Schema.String, body: Schema.String }),
);

const DecisionFromText = Schema.fromJsonString(ApprovalDecisionSchema);

const CREATE_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS mackbot_approvals (approval_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, thread TEXT, tool_path TEXT NOT NULL, summary TEXT NOT NULL, artifact TEXT, status TEXT NOT NULL, requested_at INTEGER NOT NULL, decided_at INTEGER, request_id TEXT, session_id TEXT)";

/**
 * One pause is one row. The index is what makes `recordPaused` idempotent: the
 * second insert of a `requestId` is ignored rather than minting a second
 * approval for a call that has not changed.
 */
const CREATE_REQUEST_INDEX_SQL =
  "CREATE UNIQUE INDEX IF NOT EXISTS mackbot_approvals_request ON mackbot_approvals (request_id)";

const INSERT_SQL =
  "INSERT OR IGNORE INTO mackbot_approvals (approval_id, bot_id, thread, tool_path, summary, artifact, status, requested_at, decided_at, request_id, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

const COLUMNS =
  "approval_id, bot_id, thread, tool_path, summary, artifact, status, requested_at, decided_at, session_id";

// Oldest first: the home screen shows what has been waiting longest. Bounded
// by the cap on pending approvals, so a read can never return an unbounded list.
const PENDING_SQL = `SELECT ${COLUMNS} FROM mackbot_approvals WHERE status = 'pending' ORDER BY requested_at ASC LIMIT ${MAX_PENDING_APPROVALS}`;

const PENDING_COUNT_SQL =
  "SELECT COUNT(*) AS count FROM mackbot_approvals WHERE status = 'pending'";

// The decision's own row, read before the write: the store is the single owner
// of "is this still undecided", and of what an earlier decision said.
const DECIDABLE_SQL =
  "SELECT approval_id, bot_id, request_id, session_id, status, decided_at, decision, resumed_at FROM mackbot_approvals WHERE approval_id = ?";

// Guarded on `pending` so a decided row can never be rewritten.
const DECIDE_SQL =
  "UPDATE mackbot_approvals SET status = ?, decided_at = ?, decision = ? WHERE approval_id = ? AND status = 'pending'";

// The state of one paused call, by the id Executor knows it by.
const REQUEST_STATE_SQL =
  "SELECT status, decision, resumed_at FROM mackbot_approvals WHERE request_id = ?";

// The approval a requestId already has. A pause the bridge sees again is the
// same row, and the same wait: the wait starts with the first sighting.
const REQUEST_APPROVAL_SQL = "SELECT approval_id FROM mackbot_approvals WHERE request_id = ?";

// The row a delivery reads: the decision it carries, and where to steer it.
const DELIVERY_SQL =
  "SELECT request_id, session_id, status, decision, resumed_at FROM mackbot_approvals WHERE approval_id = ?";

// The one resume a decision admits. Guarded on a decision that no resume has
// spent yet, so a second claim changes nothing.
const CLAIM_SQL =
  "UPDATE mackbot_approvals SET resumed_at = ? WHERE request_id = ? AND resumed_at IS NULL AND status IN ('allowed', 'denied')";

// Both expiries return the rows they changed, so each expiry is audited once.
const EXPIRE_SQL =
  "UPDATE mackbot_approvals SET status = 'expired', decided_at = ? WHERE approval_id = ? AND status = 'pending' RETURNING approval_id";

const EXPIRE_STALE_SQL =
  "UPDATE mackbot_approvals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND requested_at <= ? RETURNING approval_id";

// Only finished rows: a pending approval is still someone's open question.
const PRUNE_SQL =
  "DELETE FROM mackbot_approvals WHERE status <> 'pending' AND COALESCE(decided_at, requested_at) < ?";

const StatusSchema = Schema.Literals(["pending", "allowed", "denied", "expired"]);

const RequestStateSchema = Schema.Struct({
  status: StatusSchema,
  decision: Schema.NullOr(Schema.String),
  resumed_at: Schema.NullOr(Schema.Number),
});

const PendingCountSchema = Schema.Struct({ count: Schema.Number });

const ApprovalIdRowSchema = Schema.Struct({ approval_id: Schema.String });

const ApprovalRecordSchema = Schema.Struct({
  approval_id: Schema.String,
  bot_id: Schema.String,
  thread: Schema.NullOr(Schema.String),
  tool_path: Schema.String,
  summary: Schema.String,
  artifact: Schema.NullOr(Schema.String),
  status: StatusSchema,
  requested_at: Schema.Number,
  decided_at: Schema.NullOr(Schema.Number),
  session_id: Schema.NullOr(Schema.String),
});

const DecidableRecordSchema = Schema.Struct({
  approval_id: Schema.String,
  bot_id: Schema.String,
  request_id: Schema.NullOr(Schema.String),
  session_id: Schema.NullOr(Schema.String),
  status: StatusSchema,
  decided_at: Schema.NullOr(Schema.Number),
  decision: Schema.NullOr(Schema.String),
  resumed_at: Schema.NullOr(Schema.Number),
});

const DeliveryRecordSchema = Schema.Struct({
  request_id: Schema.NullOr(Schema.String),
  session_id: Schema.NullOr(Schema.String),
  status: StatusSchema,
  decision: Schema.NullOr(Schema.String),
  resumed_at: Schema.NullOr(Schema.Number),
});

/**
 * The fields a pause envelope may carry that are safe to keep. `approvalUrl` is
 * deliberately absent: it is signed for the org connection, so it is relayed to
 * the human and never stored.
 */
const EnvelopeSchema = Schema.Struct({
  invocation: Schema.optional(
    Schema.Struct({
      path: Schema.optional(Schema.String),
      tool: Schema.optional(Schema.String),
      input: Schema.optional(Schema.Unknown),
    }),
  ),
});

const EnvelopeFromText = Schema.fromJsonString(EnvelopeSchema);

type Envelope = typeof EnvelopeSchema.Type;

const rowToApproval = (row: SqlRow): Option.Option<ApprovalView> =>
  Option.flatMap(Schema.decodeUnknownOption(ApprovalRecordSchema)(row), (record) =>
    Schema.decodeUnknownOption(ApprovalViewSchema)({
      approvalId: record.approval_id,
      bot: record.bot_id,
      thread: record.thread ?? undefined,
      session: record.session_id ?? undefined,
      toolPath: record.tool_path,
      summary: record.summary,
      artifact:
        record.artifact === null
          ? undefined
          : Option.getOrUndefined(Schema.decodeUnknownOption(ArtifactSchema)(record.artifact)),
      status: record.status,
      requestedAt: record.requested_at,
      decidedAt: record.decided_at ?? undefined,
    }),
  );

/** What the store knows about one paused call. */
export type { ApprovalState, ApprovalStatus } from "./executor-policy.ts";

/** One paused call, as the bridge found it. */
export interface PausedApproval {
  readonly bot: string;
  /**
   * The pi conversation the call paused in. A decision steers this one, so it is
   * required: an approval the store cannot address is not resumable.
   */
  readonly session: string;
  /** Executor's id for the paused call. DO-private. */
  readonly requestId: string;
  /** Executor's pause payload: `structuredContent` when it sent one, else the text. */
  readonly envelope: string;
}

/**
 * What recording a pause did: a new approval, the one the requestId already
 * had, or nothing, because the bot already has as many pending approvals as it
 * may.
 */
export type PausedRecording = "recorded" | "known" | "limited";

/**
 * What a decision records, with nothing the browser must not see. It is the
 * decision route's answer, so it is the contract's shape.
 */
export type DecidedApproval = DecisionAccepted;

/**
 * The one way a decision becomes a submission. `Bot.submit` is the intended
 * implementation, so the steer gets a stream, a run and an audit row like any
 * other work.
 */
export type ApprovalSubmitter = (
  input: string,
  operationId: string,
  whenBusy: PiWhenBusy,
  session: string,
) => Promise<{ readonly accepted: boolean }>;

/**
 * The seams the store needs beyond its SQL. All are optional: a store
 * without them behaves exactly as it did before the wait existed, and a host
 * that wires neither keeps the HTTP path as the only way a decision resumes.
 */
export interface ApprovalStoreOptions {
  /**
   * Starts the durable wait for a recorded pause. The host supplies it,
   * because the harness is what can create the task and the store does not
   * know the harness's type. The task belongs to the conversation of the
   * session it waits for, and it is a background task: a wait nobody answers
   * must not hold that conversation's idle wait open.
   *
   * A host that returns its promise gets the failure logged; one that returns
   * nothing keeps the pause recorded and the HTTP decision path as the only
   * way left to resume the call. That path is idempotent, so a decision whose
   * steer was lost is delivered again by repeating it.
   */
  readonly startWait?: (wait: ApprovalWaitInput) => void | Promise<void>;
  /**
   * Submits the steer a decision admits. The wait needs one of its own: the
   * HTTP path's steer is exactly what may have been lost.
   */
  readonly submit?: ApprovalSubmitter;
  /**
   * Told about each approval the first time it is recorded, never about a
   * pause the store already knew, with the clock its wait gives up at. The
   * host puts the question to the human's phone from here; like the wait, it
   * runs behind the tool and its failure is only logged.
   */
  readonly onRecorded?: (approval: ApprovalView, deadline: number) => void;
  /**
   * A decision the human made outside the web app, e.g. on their phone, or
   * `undefined` while there is none. The wait asks on every wake while the
   * approval is pending, and an answer takes the same decision path as the
   * app's, recorded as made `via` that channel.
   */
  readonly answerOf?: (approvalId: string) => Promise<ApprovalDecision | undefined>;
  /**
   * Told once an approval stops being pending: decided, and by which channel,
   * or expired. Runs behind the decision and its failure is only logged.
   */
  readonly onSettled?: (settled: SettledApproval) => void;
  /** The clock the store stamps and expires rows by; the wall clock by default. */
  readonly now?: () => number;
  /**
   * Where the store reports each step of an approval's life. Absent, nothing is
   * audited. The rows carry ids, the tool path and the decision's action, never
   * the draft input or the form content.
   */
  readonly audit?: AuditSink;
}

/**
 * Where a decision came from: the web app's approval cards (and any other
 * caller of the decision route), or the human's phone through Hark.
 */
export type DecidedVia = "app" | "hark";

/** An approval that stopped being pending, and how. */
export type SettledApproval =
  | {
      readonly approvalId: string;
      readonly bot: string;
      readonly how: "decided";
      readonly via: DecidedVia;
      readonly status: "allowed" | "denied";
    }
  | { readonly approvalId: string; readonly how: "expired" };

/** What one delivery attempt found. */
export type ApprovalDelivery =
  /** The steer went out, or a resume already carried the decision out. */
  | "delivered"
  /** The approval is still waiting for a human. */
  | "pending"
  /** This store does not hold the approval, or it expired undecided. */
  | "unknown";

/** What the row says about a delivery. */
type Delivery =
  | {
      readonly kind: "decided";
      readonly requestId: string;
      readonly session: string;
      readonly decision: ApprovalDecision;
      readonly resumed: boolean;
    }
  | { readonly kind: "pending" }
  | { readonly kind: "unknown" };

export type ApprovalStore = {
  /**
   * Record a paused call. Idempotent on the requestId, and refused once the
   * bot has {@link MAX_PENDING_APPROVALS} approvals waiting.
   */
  readonly recordPaused: (paused: PausedApproval) => PausedRecording;
  readonly pending: () => readonly ApprovalView[];
  /**
   * What the store knows about one paused call. The executor policy asks this
   * before it lets a model resume a call, so a requestId nobody approved is
   * "unknown" rather than "pending", and an approved one carries the content
   * the human submitted and whether a resume already spent it.
   */
  readonly stateOf: (requestId: string) => ApprovalStatus;
  /**
   * Spend the one resume a decision admits: `true` the first time for a
   * decided requestId, `false` afterwards and for anything undecided.
   */
  readonly claimResume: (requestId: string) => boolean;
  /**
   * Decide a pending approval and steer the decision into its conversation.
   * Repeating the decision an approval already has delivers it again, so a
   * caller whose steer failed can retry; a different decision, or one on an
   * approval that cannot be decided, is `undefined`. `via` names the channel
   * the human decided on; the app's route by default.
   */
  readonly decide: (
    approvalId: string,
    decision: ApprovalDecision,
    submit: ApprovalSubmitter,
    via?: DecidedVia,
  ) => Promise<DecidedApproval | undefined>;
  /**
   * Submit the steer a decided approval is waiting for. The wait calls this:
   * the HTTP path may have recorded the decision and lost the steer, and the
   * steer it submits again carries the same operation id, so pi admits one
   * submission per approval. A pending approval asks the host's `answerOf`
   * first, so a decision made on the phone is carried out from here.
   */
  readonly deliver: (approvalId: string) => Promise<ApprovalDelivery>;
  /** Mark an approval nobody decided as expired; a decided one is left alone. */
  readonly expire: (approvalId: string) => void;
  /**
   * Drop decided and expired approvals older than `olderThanMs` (default
   * {@link APPROVAL_RETENTION_MS}). Pending approvals are never dropped.
   */
  readonly prune: (olderThanMs?: number) => void;
};

const envelopeOf = (raw: string): Envelope | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(EnvelopeFromText)(raw));

const toolOf = (envelope: Envelope | undefined): string | undefined =>
  envelope?.invocation?.path ?? envelope?.invocation?.tool;

/**
 * The draft the call would carry out, when the envelope carries one. An
 * approval that cannot show what it will do is the one thing the design calls
 * unacceptable, so the input is rendered verbatim; an absent input is not a
 * draft and leaves the artifact off, and {@link summaryOf} says so.
 */
const artifactOf = (
  tool: string | undefined,
  envelope: Envelope | undefined,
): { readonly label: string; readonly body: string } | undefined => {
  const input = envelope?.invocation?.input;
  if (input === undefined) return undefined;
  return {
    label: `${tool ?? "Executor"} — what it will do`,
    body: toPrettyJson(input),
  };
};

/**
 * A phrase a human can decide on. Executor's `model` elicitation mode returns
 * the requestId and little else, so the summary states plainly what the pause
 * could not tell us rather than inventing a promise.
 */
const summaryOf = (
  tool: string | undefined,
  artifact: { readonly label: string; readonly body: string } | undefined,
): string => {
  if (tool === undefined) {
    return "Executor paused a call for your approval. The pause carried no tool name or draft to show.";
  }
  if (artifact === undefined)
    return `Approve ${tool}? The pause carried no draft input to preview.`;
  return `Approve ${tool}?`;
};

/** The steer the model answers: the requestId it must resume, and how. */
const resumeText = (requestId: string, decision: ApprovalDecision): string => {
  const action = decision.action === "allow" ? "accept" : "decline";
  const response =
    decision.content === undefined ? { action } : { action, content: decision.content };
  return [
    `A human ${decision.action === "allow" ? "approved" : "denied"} the Executor request ${toJson(requestId)} that paused earlier.`,
    `Call executor_resume with requestId ${toJson(requestId)} and response ${toJson(response)}.`,
    "Do not repeat the original call; the resume is what carries the decision out.",
  ].join(" ");
};

/**
 * The decision a decided row carries. A row decided before the decision was
 * stored keeps only its status, which is the decision without content.
 */
const decisionOf = (status: "allowed" | "denied", stored: string | null): ApprovalDecision => {
  const decoded =
    stored === null
      ? undefined
      : Option.getOrUndefined(Schema.decodeUnknownOption(DecisionFromText)(stored));
  return decoded ?? { action: status === "allowed" ? "allow" : "deny" };
};

const sameDecision = (left: ApprovalDecision, right: ApprovalDecision): boolean =>
  left.action === right.action && sameApprovalContent(left.content, right.content);

/**
 * Run a host hook without waiting for it: a throw or a rejection becomes the
 * log line `describe` writes, never a failure of the caller.
 */
const behindTheTool = (
  run: () => void | Promise<void>,
  describe: (cause: unknown) => string,
): void => {
  void Effect.runPromise(
    Effect.tryPromise({
      try: async () => run(),
      catch: (cause: unknown) => cause,
    }).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          console.error(describe(cause));
        }),
      ),
    ),
  );
};

export function createApprovalStore(
  storage: SqlStorage,
  options?: ApprovalStoreOptions,
): ApprovalStore {
  const executor: SqlExecutor = storage.sql;
  const now = options?.now ?? currentTimeMillis;
  const audit: AuditSink = options?.audit ?? (() => undefined);
  let migrated = false;

  // The table is created lazily, so a bot that already ran an earlier revision
  // has it without the later columns. `ADD COLUMN` has no `IF NOT EXISTS`, so
  // the current shape is read first.
  const addColumn = (name: string, type: "TEXT" | "INTEGER"): void => {
    const present = read(executor, "PRAGMA table_info(mackbot_approvals)").some(
      (row) => row.name === name,
    );
    if (!present) write(executor, `ALTER TABLE mackbot_approvals ADD COLUMN ${name} ${type}`);
  };

  const ensureMigrated = (): void => {
    if (migrated) return;
    write(executor, CREATE_TABLE_SQL);
    addColumn("request_id", "TEXT");
    addColumn("session_id", "TEXT");
    addColumn("decision", "TEXT");
    addColumn("resumed_at", "INTEGER");
    write(executor, CREATE_REQUEST_INDEX_SQL);
    migrated = true;
  };

  /**
   * The approval ids a statement returned, each audited as expired and
   * announced, so a question put to the phone is withdrawn with it.
   */
  const settleExpired = (rows: readonly SqlRow[], by: "deadline" | "wait"): void => {
    for (const row of rows) {
      for (const expired of Option.toArray(Schema.decodeUnknownOption(ApprovalIdRowSchema)(row))) {
        audit({
          kind: "approval.expired",
          operationId: approvalOperationId(expired.approval_id),
          detail: { approvalId: expired.approval_id, by },
        });
        behindTheTool(
          () => options?.onSettled?.({ approvalId: expired.approval_id, how: "expired" }),
          (cause) =>
            `mackbot: announcing the expiry of "${expired.approval_id}" failed: ${describeCause(cause)}`,
        );
      }
    }
  };

  /**
   * Expire every pending approval whose wait has given up. A wait that never
   * started, or died with its Durable Object, would otherwise leave its row
   * pending forever.
   */
  const expireStale = (at: number): void => {
    settleExpired(read(executor, EXPIRE_STALE_SQL, at, at - WAIT_DEADLINE_MS), "deadline");
  };

  /** Migrate, expire what is past its deadline, and say what time it is. */
  const prepare = (): number => {
    ensureMigrated();
    const at = now();
    expireStale(at);
    return at;
  };

  const pendingCount = (): number =>
    Option.getOrElse(
      Option.map(
        Schema.decodeUnknownOption(PendingCountSchema)(read(executor, PENDING_COUNT_SQL)[0]),
        (row) => row.count,
      ),
      () => 0,
    );

  const insert = (approval: ApprovalView, requestId: string, session: string): void => {
    const values: SqlValue[] = [
      approval.approvalId,
      approval.bot,
      approval.thread ?? null,
      approval.toolPath,
      approval.summary,
      approval.artifact === undefined ? null : toJson(approval.artifact),
      approval.status,
      approval.requestedAt,
      approval.decidedAt ?? null,
      requestId,
      session,
    ];
    write(executor, INSERT_SQL, ...values);
  };

  const recordPaused = (paused: PausedApproval): PausedRecording => {
    const at = prepare();
    // A pause the bridge sees again is the same row, and the same wait: the
    // wait starts with the first sighting, not with every one of them.
    if (read(executor, REQUEST_APPROVAL_SQL, paused.requestId).length > 0) return "known";
    if (pendingCount() >= MAX_PENDING_APPROVALS) {
      console.error(
        `mackbot: bot "${paused.bot}" already has ${MAX_PENDING_APPROVALS} pending approvals; a further paused call was not recorded and cannot be resumed.`,
      );
      audit({
        kind: "approval.limited",
        operationId: pausedCallAuditId(paused.requestId),
        detail: { session: paused.session, pending: MAX_PENDING_APPROVALS },
      });
      return "limited";
    }
    const envelope = envelopeOf(paused.envelope);
    const tool = toolOf(envelope);
    const artifact = artifactOf(tool, envelope);
    // The id names the approval in a URL, so it comes from the CSPRNG: Effect's
    // `Random` is not one, and effect/Crypto ships no WebCrypto layer.
    // oxlint-disable-next-line forge/no-ambient-nondeterminism -- unguessable id
    const approvalId = crypto.randomUUID();
    const approval = Schema.decodeUnknownSync(ApprovalViewSchema)({
      approvalId,
      bot: paused.bot,
      toolPath: tool ?? "executor",
      summary: summaryOf(tool, artifact),
      artifact,
      status: "pending",
      requestedAt: at,
    });
    insert(approval, paused.requestId, paused.session);
    audit({
      kind: "approval.requested",
      operationId: approvalOperationId(approvalId),
      detail: { approvalId, toolPath: tool ?? "executor", session: paused.session },
    });
    const wait: ApprovalWaitInput = {
      approvalId,
      requestId: paused.requestId,
      session: paused.session,
      deadline: at + WAIT_DEADLINE_MS,
    };
    // The wait starts behind the tool, never inside it: a tool that paused has
    // a result to return, and the wait's failure is a log line rather than a
    // failed call. The store is not consulted again from module scope, so the
    // wait the host starts here is the one the Harness can resume.
    behindTheTool(
      () => options?.startWait?.(wait),
      (cause) =>
        `mackbot: starting the approval wait for "${approvalId}" failed: ${describeCause(cause)}. Repeating the decision delivers it.`,
    );
    behindTheTool(
      () => options?.onRecorded?.(approval, wait.deadline),
      (cause) => `mackbot: announcing the approval "${approvalId}" failed: ${describeCause(cause)}`,
    );
    return "recorded";
  };

  const pending = (): readonly ApprovalView[] => {
    prepare();
    return read(executor, PENDING_SQL).flatMap((row) => Option.toArray(rowToApproval(row)));
  };

  const stateOf = (requestId: string): ApprovalStatus => {
    prepare();
    const rows = read(executor, REQUEST_STATE_SQL, requestId);
    const record = Option.getOrUndefined(Schema.decodeUnknownOption(RequestStateSchema)(rows[0]));
    if (record === undefined) return { state: "unknown" };
    const status = record.status;
    if (status === "pending") return { state: "pending" };
    // An expired approval is not a decision, so nothing vouches for it.
    if (status === "expired") return { state: "unknown" };
    const decision = decisionOf(status, record.decision);
    return {
      state: status === "allowed" ? "approved" : "denied",
      content: decision.content,
      resumed: record.resumed_at !== null,
    };
  };

  const claimResume = (requestId: string): boolean => {
    ensureMigrated();
    const before = Option.getOrUndefined(
      Schema.decodeUnknownOption(RequestStateSchema)(
        read(executor, REQUEST_STATE_SQL, requestId)[0],
      ),
    );
    if (before === undefined || before.resumed_at !== null) return false;
    if (before.status !== "allowed" && before.status !== "denied") return false;
    // Durable Object SQL runs synchronously on one thread, so nothing can claim
    // between the read above and this write.
    write(executor, CLAIM_SQL, now(), requestId);
    for (const claimed of Option.toArray(
      Schema.decodeUnknownOption(ApprovalIdRowSchema)(
        read(executor, REQUEST_APPROVAL_SQL, requestId)[0],
      ),
    )) {
      audit({
        kind: "approval.resumed",
        operationId: approvalOperationId(claimed.approval_id),
        detail: { approvalId: claimed.approval_id, status: before.status },
      });
    }
    return true;
  };

  /** The approval a decision can act on, or `undefined` when it cannot. */
  const decidable = (approvalId: string): DecidableApproval | undefined =>
    Option.getOrUndefined(
      Option.flatMap(
        Schema.decodeUnknownOption(DecidableRecordSchema)(
          read(executor, DECIDABLE_SQL, approvalId)[0],
        ),
        (record): Option.Option<DecidableApproval> => {
          if (record.request_id === null || record.session_id === null) return Option.none();
          const base = {
            bot: record.bot_id,
            requestId: record.request_id,
            session: record.session_id,
          };
          const status = record.status;
          if (status === "pending") return Option.some({ ...base, kind: "pending" });
          if (status === "expired") return Option.none();
          return Option.some({
            ...base,
            kind: "decided",
            status,
            decidedAt: record.decided_at ?? 0,
            decision: decisionOf(status, record.decision),
            resumed: record.resumed_at !== null,
          });
        },
      ),
    );

  const decide = async (
    approvalId: string,
    decision: ApprovalDecision,
    submit: ApprovalSubmitter,
    via: DecidedVia = "app",
  ): Promise<DecidedApproval | undefined> => {
    const at = prepare();
    const row = decidable(approvalId);
    if (row === undefined) return undefined;
    const status = decision.action === "allow" ? "allowed" : "denied";
    if (row.kind === "decided") {
      // A repeat of the decision the approval already has is a retry: the
      // earlier steer may have been lost. Any other decision would overturn
      // the human's answer, and a resume that already ran needs no steer.
      if (!sameDecision(row.decision, decision)) return undefined;
      const decided = { approvalId, bot: row.bot, status: row.status, decidedAt: row.decidedAt };
      if (row.resumed) return decided;
      audit({
        kind: "approval.redelivered",
        operationId: approvalOperationId(approvalId),
        detail: { approvalId, action: row.decision.action },
      });
      await submit(
        resumeText(row.requestId, row.decision),
        approvalOperationId(approvalId),
        "steer",
        row.session,
      );
      return decided;
    }
    // Durable before the steer: a crash after this leaves the decision recorded
    // and the row out of `pending`, a crash before it leaves the approval alone.
    write(executor, DECIDE_SQL, status, at, toJson(decision), approvalId);
    // A decision comes in by the HTTP route, whose steer is named for it, or
    // from the phone through Hark; the audit row names the channel it came by.
    // No person is named: the Worker has one operator and no user identity.
    audit({
      kind: "approval.decided",
      operationId: approvalOperationId(approvalId),
      detail: {
        approvalId,
        action: decision.action,
        withContent: decision.content !== undefined,
        channel: via === "hark" ? "hark" : originOf(approvalOperationId(approvalId)),
      },
    });
    behindTheTool(
      () => options?.onSettled?.({ approvalId, bot: row.bot, how: "decided", via, status }),
      (cause) =>
        `mackbot: announcing the decision on "${approvalId}" failed: ${describeCause(cause)}`,
    );
    await submit(
      resumeText(row.requestId, decision),
      approvalOperationId(approvalId),
      "steer",
      row.session,
    );
    return { approvalId, bot: row.bot, status, decidedAt: at };
  };

  /** What the row says about a delivery: a decision to carry, or none yet. */
  const deliveryOf = (approvalId: string): Delivery => {
    const record = Option.getOrUndefined(
      Schema.decodeUnknownOption(DeliveryRecordSchema)(read(executor, DELIVERY_SQL, approvalId)[0]),
    );
    if (record === undefined || record.status === "expired") return { kind: "unknown" };
    if (record.status === "pending") return { kind: "pending" };
    if (record.request_id === null || record.session_id === null) {
      return { kind: "unknown" };
    }
    return {
      kind: "decided",
      requestId: record.request_id,
      session: record.session_id,
      decision: decisionOf(record.status, record.decision),
      resumed: record.resumed_at !== null,
    };
  };

  /**
   * The steer a decided approval is waiting for. The decision comes from the
   * row, form content included, so the recovery carries the answer the human
   * gave and the policy admits the resume it asks for.
   */
  const deliver = async (approvalId: string): Promise<ApprovalDelivery> => {
    prepare();
    const row = deliveryOf(approvalId);
    if (row.kind === "unknown") return "unknown";
    if (row.kind === "pending") return await answerFromElsewhere(approvalId);
    // A resume already carried the decision out; a steer now would only ask the
    // model for a resume the policy refuses.
    if (row.resumed) return "delivered";
    const submit = options?.submit;
    // Without a submitter the decision stands and the steer waits for one:
    // the wait keeps looking rather than giving up on a decided approval.
    if (submit === undefined) return "pending";
    audit({
      kind: "approval.delivered",
      operationId: approvalOperationId(approvalId),
      detail: { approvalId, action: row.decision.action },
    });
    await submit(
      resumeText(row.requestId, row.decision),
      approvalOperationId(approvalId),
      "steer",
      row.session,
    );
    return "delivered";
  };

  /**
   * A pending approval the human may have answered on another channel. The
   * answer goes through {@link decide}, the web app's own path, so the policy
   * finds the same durable decision vouching for the resume. A host that
   * cannot ask, or a channel that fails, leaves the approval pending.
   */
  const answerFromElsewhere = async (approvalId: string): Promise<ApprovalDelivery> => {
    const answerOf = options?.answerOf;
    const submit = options?.submit;
    if (answerOf === undefined || submit === undefined) return "pending";
    const answer = await Effect.runPromise(
      Effect.tryPromise(() => answerOf(approvalId)).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            console.error(
              `mackbot: reading the answer to "${approvalId}" failed: ${describeCause(cause)}`,
            );
            return undefined;
          }),
        ),
      ),
    );
    if (answer === undefined) return "pending";
    const decided = await decide(approvalId, answer, submit, "hark");
    return decided === undefined ? "pending" : "delivered";
  };

  const expire = (approvalId: string): void => {
    ensureMigrated();
    settleExpired(read(executor, EXPIRE_SQL, now(), approvalId), "wait");
  };

  const prune = (olderThanMs: number = APPROVAL_RETENTION_MS): void => {
    ensureMigrated();
    write(executor, PRUNE_SQL, now() - olderThanMs);
  };

  const store: ApprovalStore = {
    recordPaused,
    pending,
    stateOf,
    claimResume,
    decide,
    deliver,
    expire,
    prune,
  };
  return store;
}

/** A row a decision can act on; kept off {@link DecidedApproval}. */
type DecidableApproval = {
  readonly bot: string;
  readonly requestId: string;
  readonly session: string;
} & (
  | { readonly kind: "pending" }
  | {
      readonly kind: "decided";
      readonly status: "allowed" | "denied";
      readonly decidedAt: number;
      readonly decision: ApprovalDecision;
      readonly resumed: boolean;
    }
);

// ---------------------------------------------------------------------------
// The wait: the pause leaves a durable task behind, and the task delivers.
// ---------------------------------------------------------------------------

/** The approval a wait watches, and the clock at which it stops watching. */
export interface ApprovalWaitInput {
  readonly approvalId: string;
  /** Executor's id for the paused call. */
  readonly requestId: string;
  /** The pi conversation the call paused in. */
  readonly session: string;
  /** The clock at which the wait gives up. */
  readonly deadline: number;
}

/** Where the wait is: asleep, or looking at the approval. */
export type ApprovalWaitCheckpoint =
  | { readonly phase: "wait" }
  | { readonly phase: "deliver"; readonly delivered: boolean };

/** The receipt of a wait that delivered its decision. */
export interface ApprovalWaitOutcome {
  /** The approval whose decision was delivered. */
  readonly approvalId: string;
  /** The operation id the steer carried: pi admits one submission under it. */
  readonly operationId: string;
}

/** The clock of the next look, or the deadline when that comes first. */
const nextPoll = (now: number, deadline: number): number => Math.min(now + WAIT_POLL_MS, deadline);

/** The outcome of a wait that delivered the decision. */
const delivered = (
  approvalId: string,
): NextTaskState<ApprovalWaitCheckpoint, ApprovalWaitOutcome> => ({
  status: "terminal",
  outcome: {
    status: "completed",
    result: { approvalId, operationId: approvalOperationId(approvalId) },
  },
});

/** The outcome of a wait that nobody decided in time. */
const expired = (
  approvalId: string,
): NextTaskState<ApprovalWaitCheckpoint, ApprovalWaitOutcome> => ({
  status: "terminal",
  outcome: {
    status: "failed",
    error: { message: `the approval ${approvalId} was not decided before its deadline` },
  },
});

/**
 * The wait a paused call leaves behind.
 *
 * The wait holds no invocation between its polls: it sleeps until the next
 * one, and the Harness clock wakes it. The sleep is durable, so a Durable
 * Object that dies between a decision and its steer finds the wait when it
 * comes back, and the wait delivers what the HTTP path never got to.
 *
 * The store is the factory's, not a module-level lookup: the Harness resumes a
 * wait before the host has asked the bot for anything, so the wait has to carry
 * everything it delivers through. A task that looked its store up would resume
 * with nothing to look at and poll until its deadline.
 *
 * The delivery is the HTTP path's own steer under the same operation id, so
 * pi's request-id idempotency joins it to the first submission instead of
 * starting a second run.
 *
 * The wait phase owns the sleep: the deliver phase hands the wait over to it
 * when the approval is still undecided, so one poll is one sleep long.
 */
export const createApprovalWait = (
  store: ApprovalStore,
): Task<ApprovalWaitInput, ApprovalWaitCheckpoint, ApprovalWaitOutcome, object> =>
  defineTask<ApprovalWaitInput, ApprovalWaitCheckpoint, ApprovalWaitOutcome>({
    name: "mackbot.approval-wait",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (task, runtime, context) => {
        const until = nextPoll(runtime.now(), task.input.deadline);
        if (until <= runtime.now()) {
          store.expire(task.input.approvalId);
          await runtime.commit(() => expired(task.input.approvalId), context);
          return;
        }
        await runtime.sleepUntil(until, { phase: "deliver", delivered: false }, context);
      },
      deliver: async (task, runtime, context) => {
        if (task.state.checkpoint.delivered) {
          await runtime.commit(() => delivered(task.input.approvalId), context);
          return;
        }
        const delivery = await store.deliver(task.input.approvalId);
        if (delivery === "delivered") {
          await runtime.commit(
            () => ({ status: "running", checkpoint: { phase: "deliver", delivered: true } }),
            context,
          );
          return;
        }
        // An approval the store no longer holds as decidable (expired, or
        // pruned) will never be decided: the wait stops rather than polling on.
        if (delivery === "unknown" || runtime.now() >= task.input.deadline) {
          store.expire(task.input.approvalId);
          await runtime.commit(() => expired(task.input.approvalId), context);
          return;
        }
        await runtime.commit(() => ({ status: "running", checkpoint: { phase: "wait" } }), context);
      },
    },
    abort: async (task, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });

/**
 * The extension the host installs in its harness factory: the wait over the
 * store the same bot's approvals live in. The extension keeps the name
 * `mackbot-approvals` and the task keeps the kind `mackbot.approval-wait` at
 * version 1, so a wait a previous revision started still resolves to this
 * definition and resumes where it slept.
 */
export const createApprovalExtension = (store: ApprovalStore): Extension =>
  defineExtension({ name: "mackbot-approvals", tasks: [createApprovalWait(store)] });
