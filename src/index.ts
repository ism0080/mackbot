/**
 * mackbot — the front door Worker and the `Bot` Durable Object.
 *
 * ## Front door
 *
 * One plain async Worker (no framework) that validates, then routes to one
 * Durable Object instance per bot (`env.Bot.getByName(botId)`). It never does
 * model work itself.
 *
 *   POST /chat/:bot   bearer auth   submit a message; long-poll for the answer
 *   GET  /status      bearer auth   per-bot status: model, busy, pending, usage
 *
 * Auth is a shared bearer secret in `CHAT_BEARER_TOKEN` (`Authorization: Bearer
 * <token>`), enforced on every route — anyone who finds the URL could otherwise
 * drive the bots and their Executor spend. Missing/invalid bearer is 401; an
 * unknown bot id is 404 (validated against `loadBots()`).
 *
 * `POST /chat/:bot` body: `{ "text": "...", "operationId"?: "...", "whenBusy"?:
 * "followUp" | "steer", "wait"?: boolean }`. Admission is durable and
 * at-most-once by `operationId` (client-supplied, else a generated
 * `http:<uuid>`): the same id twice returns the same receipt and never starts a
 * second run. The default response long-polls (bounded at
 * {@link LONG_POLL_TIMEOUT_MS}) until the submission settles and returns the
 * final answer — this is what surfaces a paused Executor approval's
 * `approvalUrl` over HTTP. `?wait=0` (or `"wait": false`) returns the receipt
 * `{ operationId, accepted }` immediately for callers who poll. On long-poll
 * timeout the caller gets `{ status: "timeout" }` and retries with the same
 * `operationId`, which is idempotent.
 *
 * The hourly cron (`scheduled`) submits each bot's `brief` with a stable
 * `cron:<botId>:<scheduledTime>` operationId, so an alarm retry cannot
 * double-run. Bots without a `brief` are skipped.
 *
 * ## `Bot` Durable Object
 *
 * Hosts a pi-durable `PiHarness` behind the `agents` SDK `Lifecycle` (which
 * owns the DO's wake-up alarms). Per-bot config (model, thinking level,
 * instructions) lives in the *conversation*, never the class or factory — DO
 * instances of one class share isolates, so class/factory state cannot hold a
 * bot's identity. `#ensureBot()` applies it to the root session's `pi.agent`
 * idempotently (an `AgentChange` via `Conversation.configure`), re-applied once
 * per instance lifetime so it survives eviction.
 *
 * The harness is opened with the progress-interval tuning and compaction
 * settings from the plan's cost posture (~10x fewer SQLite row writes; long-
 * lived bots don't die on context).
 */

import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { PiHarness, ROOT_SESSION } from "agents/harness/pi";
import type { PiHarnessFactory, PiReceipt, PiWhenBusy } from "agents/harness/pi";
import { createAI } from "agents/models/pi-ai";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import type { AgentChange, HarnessSettings, UsageState } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createExecutorMcp } from "./executor-mcp.ts";
import { getBot, loadBots, resolveModelRef } from "./bots.ts";
import type { ModelRef, ThinkingLevel } from "./bots.ts";

/**
 * The Worker's bindings. `OPENCODE_API_KEY` is not read here directly: pi-ai
 * resolves it from `process.env` (populated from this binding under
 * `nodejs_compat`), so it must be bound for the harness to authenticate.
 */
export interface Env {
  readonly Bot: DurableObjectNamespace<Bot>;
  readonly AI: Ai;
  readonly EXECUTOR_URL: string;
  readonly EXECUTOR_TOKEN: string;
  readonly OPENCODE_API_KEY: string;
  readonly CHAT_BEARER_TOKEN: string;
}

/** One unsettled submission, as `/status` reports it. */
export interface PendingOperation {
  readonly operationId: string;
  readonly status: "queued" | "running";
}

/** One bot's status, as `/status` reports it. */
export interface BotStatus {
  readonly id: string;
  readonly model: ModelRef;
  readonly thinkingLevel: ThinkingLevel | null;
  readonly busy: boolean;
  readonly pending: readonly PendingOperation[];
  /** pi's per-conversation spend ledger, summed over the session. */
  readonly usage: UsageState;
}

/** The outcome of waiting on an operation. `timeout` means "still running". */
export interface WaitResult {
  readonly operationId: string;
  readonly session: string;
  readonly status: "done" | "unanswered" | "timeout";
  readonly text?: string;
  readonly reason?: string;
}

/** Bound on the long-poll; callers retry with the same id on timeout. */
const LONG_POLL_TIMEOUT_MS = 55_000;

/**
 * The harness settings from the plan's cost posture: commit progress once a
 * second instead of the 100ms default (~10x fewer SQLite row writes) and keep
 * 16k tokens free for the answer so compaction runs before the context fills.
 */
const HARNESS_SETTINGS: HarnessSettings = {
  progress: { partialIntervalMs: 1_000, outputIntervalMs: 1_000 },
  compaction: { enabled: true, reserveTokens: 16_384 },
};

/**
 * Map a bot's declared thinking level to pi-ai's. The registry's `"none"` (a
 * model with no variants) is pi-ai's `"off"`; every other level is shared.
 */
const toThinkingLevel = (level: ThinkingLevel): ModelThinkingLevel =>
  level === "none" ? "off" : level;

/**
 * Build the factory that opens pi's `Harness` over the DO's SQLite storage.
 *
 * Models: the OpenCode Go catalog (pi-ai's `opencodeGoProvider`, which resolves
 * `OPENCODE_API_KEY`) plus Workers AI through the `AI` binding
 * (`createAI(...).provider`, provider id `cloudflare`) — the two providers the
 * registry's model declarations can resolve to. The Executor bridge extension
 * is installed in the registry, so every conversation reaches Executor.
 */
const makeHarnessFactory =
  (env: Env): PiHarnessFactory =>
  async ({ storage, context }) => {
    const registry = createRegistry();
    registry.install(createExecutorMcp({ url: env.EXECUTOR_URL, token: env.EXECUTOR_TOKEN }));
    const models = createModels();
    models.setProvider(opencodeGoProvider());
    models.setProvider(createAI({ binding: env.AI }).provider);
    return Harness.open(storage, { models, registry, settings: HARNESS_SETTINGS }, context);
  };

/**
 * One bot: a pi-durable `PiHarness` hosted in a SQLite-backed Durable Object,
 * addressed by the bot id (`ctx.id.name`).
 */
export class Bot extends DurableObject<Env> {
  /** The `agents` lifecycle that owns the DO's alarms and hosts the harness. */
  readonly lifecycle: Lifecycle<Env>;
  /** The pi-durable harness: durable submissions, waiting, and status. */
  readonly harness: PiHarness;
  #botReady: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle = Lifecycle.install(this);
    this.harness = new PiHarness({ harness: makeHarnessFactory(env) });
    this.lifecycle.use(this.harness);
  }

  /**
   * Durably admit one message. Resolves once it is admitted, before the model
   * runs; `operationId` makes it at-most-once across retries and evictions.
   */
  async submit(text: string, operationId: string, whenBusy: PiWhenBusy): Promise<PiReceipt> {
    await this.lifecycle.start();
    await this.#ensureBot();
    return this.harness.submit(text, { operationId, whenBusy });
  }

  /**
   * Wait for an admitted operation to settle, bounded by `timeoutMs`. A timeout
   * leaves the run untouched; the caller retries with the same `operationId`.
   */
  async wait(operationId: string, timeoutMs: number): Promise<WaitResult> {
    await this.lifecycle.start();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await this.harness.wait(operationId, { signal: controller.signal });
      return {
        operationId: result.operationId,
        session: result.session,
        status: result.status,
        text: result.text,
        reason: result.reason,
      };
    } catch (cause) {
      if (controller.signal.aborted) {
        return { operationId, session: ROOT_SESSION, status: "timeout" };
      }
      throw cause;
    } finally {
      clearTimeout(timer);
    }
  }

  /** This bot's resolved config, busy state, pending work, and pi usage. */
  async status(): Promise<BotStatus> {
    await this.lifecycle.start();
    const id = this.lifecycle.name;
    const bot = getBot(id);
    const [busy, pending, usage] = await Promise.all([
      this.harness.session(ROOT_SESSION).busy(),
      this.harness.pending(),
      this.#usage(),
    ]);
    return {
      id,
      model: resolveModelRef(bot),
      thinkingLevel: bot.thinkingLevel ?? null,
      busy,
      pending: pending.map((operation) => ({
        operationId: operation.operationId,
        status: operation.status,
      })),
      usage,
    };
  }

  /**
   * Apply the bot's config to the root conversation, once per instance. An
   * eviction clears the in-memory guard, so the next request re-applies it;
   * `configure` replaces the stored fields, so re-applying is a no-op in effect.
   */
  #ensureBot(): Promise<void> {
    const ready = (this.#botReady ??= this.#applyBot());
    return ready;
  }

  async #applyBot(): Promise<void> {
    const bot = getBot(this.lifecycle.name);
    const model = resolveModelRef(bot);
    const pi = await this.harness.pi();
    const root = await pi.root(BACKGROUND_CONTEXT);
    const thinkingLevel = bot.thinkingLevel;
    const change: AgentChange =
      thinkingLevel === undefined
        ? {
            model: { provider: model.provider, modelId: model.id },
            instructions: bot.systemPrompt,
          }
        : {
            model: { provider: model.provider, modelId: model.id },
            thinkingLevel: toThinkingLevel(thinkingLevel),
            instructions: bot.systemPrompt,
          };
    await root.configure(change, BACKGROUND_CONTEXT);
  }

  async #usage(): Promise<UsageState> {
    const pi = await this.harness.pi();
    return pi.usage(BACKGROUND_CONTEXT);
  }
}

/** A parsed JSON object, as `JSON.parse` (and `request.json`) yields one. */
interface RawObject {
  readonly [key: string]: RawJson;
}
/** A parsed JSON value. */
type RawJson = string | number | boolean | null | readonly RawJson[] | RawObject;

interface ChatRequest {
  readonly text: string;
  readonly operationId?: string;
  readonly whenBusy?: PiWhenBusy;
  readonly wait?: boolean;
}

interface DraftChatRequest {
  text: string;
  operationId?: string;
  whenBusy?: PiWhenBusy;
  wait?: boolean;
}

const isString = (value: RawJson | undefined): value is string =>
  Object.prototype.toString.call(value) === "[object String]";

const isBoolean = (value: RawJson | undefined): value is boolean =>
  Object.prototype.toString.call(value) === "[object Boolean]";

const isObject = (value: RawJson | undefined): value is RawObject =>
  Object.prototype.toString.call(value) === "[object Object]";

const isWhenBusy = (value: RawJson | undefined): value is PiWhenBusy =>
  value === "followUp" || value === "steer";

const field = (raw: RawObject, key: string): RawJson | undefined =>
  Object.hasOwn(raw, key) ? raw[key] : undefined;

/** Decode and validate a `/chat/:bot` body, or `undefined` when malformed. */
const readChatRequest = async (request: Request): Promise<ChatRequest | undefined> => {
  let raw: RawJson;
  try {
    raw = await request.json<RawJson>();
  } catch {
    return undefined;
  }
  if (!isObject(raw)) return undefined;
  const text = field(raw, "text");
  if (!isString(text) || text.trim().length === 0) return undefined;
  const operationId = field(raw, "operationId");
  if (operationId !== undefined && (!isString(operationId) || operationId.length === 0)) {
    return undefined;
  }
  const whenBusy = field(raw, "whenBusy");
  if (whenBusy !== undefined && !isWhenBusy(whenBusy)) return undefined;
  const wait = field(raw, "wait");
  if (wait !== undefined && !isBoolean(wait)) return undefined;
  const body: DraftChatRequest = { text };
  if (operationId !== undefined) body.operationId = operationId;
  if (whenBusy !== undefined) body.whenBusy = whenBusy;
  if (wait !== undefined) body.wait = wait;
  return body;
};

const BEARER_PATTERN = /^Bearer\s+(.+)$/u;

const isAuthorized = (request: Request, env: Env): boolean => {
  const header = request.headers.get("Authorization");
  if (header === null) return false;
  const token = BEARER_PATTERN.exec(header)?.[1];
  return token !== undefined && token === env.CHAT_BEARER_TOKEN;
};

const CHAT_ROUTE = /^\/chat\/([^/]+)$/u;

const methodNotAllowed = (): Response =>
  Response.json({ error: "method not allowed" }, { status: 405 });

/** `POST /chat/:bot`: admit durably, then long-poll (or return the receipt). */
const handleChat = async (
  request: Request,
  env: Env,
  botId: string,
  immediate: boolean,
): Promise<Response> => {
  const bots = loadBots();
  if (!Object.hasOwn(bots, botId)) {
    return Response.json({ error: `unknown bot "${botId}"` }, { status: 404 });
  }
  const body = await readChatRequest(request);
  if (body === undefined) {
    return Response.json({ error: "invalid request body" }, { status: 400 });
  }
  const operationId = body.operationId ?? `http:${crypto.randomUUID()}`;
  const stub = env.Bot.getByName(botId);
  const receipt = await stub.submit(body.text, operationId, body.whenBusy ?? "followUp");
  if (immediate || body.wait === false) {
    return Response.json(
      { operationId: receipt.operationId, accepted: receipt.accepted },
      { status: 202 },
    );
  }
  const result = await stub.wait(operationId, LONG_POLL_TIMEOUT_MS);
  if (result.status === "timeout") {
    // Still running: hand back the receipt + status so the caller can retry
    // with the same operationId (idempotent).
    return Response.json(
      { operationId, accepted: receipt.accepted, status: result.status },
      { status: 202 },
    );
  }
  return Response.json(result, { status: 200 });
};

/** `GET /status`: fan out to every bot's DO and collect their status. */
const handleStatus = async (env: Env): Promise<Response> => {
  const bots = loadBots();
  const statuses = await Promise.all(
    Object.keys(bots).map(async (id) => [id, await env.Bot.getByName(id).status()] as const),
  );
  return Response.json({ bots: Object.fromEntries(statuses) });
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!isAuthorized(request, env)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = new URL(request.url);
    if (url.pathname === "/status") {
      return request.method === "GET" ? handleStatus(env) : methodNotAllowed();
    }
    const match = CHAT_ROUTE.exec(url.pathname);
    if (match !== null) {
      return request.method === "POST"
        ? handleChat(request, env, match[1], url.searchParams.get("wait") === "0")
        : methodNotAllowed();
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const scheduledTime = controller.scheduledTime;
    const bots = loadBots();
    const admissions: Promise<PiReceipt>[] = [];
    for (const [id, bot] of Object.entries(bots)) {
      const brief = bot.brief;
      if (brief === undefined) continue;
      admissions.push(
        env.Bot.getByName(id).submit(brief, `cron:${id}:${scheduledTime}`, "followUp"),
      );
    }
    await Promise.all(admissions);
  },
};
