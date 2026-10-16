
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { PiHarness, ROOT_SESSION } from "agents/harness/pi";
import type { PiHarnessFactory, PiReceipt, PiWhenBusy } from "agents/harness/pi";
import { Streams } from "agents/streams";
import { createAI } from "agents/models/pi-ai";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import type {
  AgentChange,
  ConversationId,
  EntryRecord,
  HarnessSettings,
  UsageState,
} from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createExecutorMcp } from "./executor-mcp.ts";
import type { PausedCall, PausedSink } from "./executor-mcp.ts";
import { createBotDelegation } from "./bot-delegation.ts";
import { createFeed } from "./feed.ts";
import type { Feed } from "./feed.ts";
import { cronOperationId, httpOperationId, originOf } from "./operation.ts";
import { isAuthorized, readChatRequest } from "./chat-request.ts";
import { LONG_POLL_TIMEOUT_MS } from "./constants.ts";
import { resolveModelRef } from "./bots.ts";
import type { BotConfig } from "./bots.ts";
import type { ThinkingLevel } from "./bots.ts";
import { createApprovalStore } from "./approvals.ts";
import type { ApprovalStore, DecidedApproval } from "./approvals.ts";
import { createRunStore, streamViewOf } from "./runs.ts";
import type { RunStore } from "./runs.ts";
import { activeRunOf, projectStatus } from "./status.ts";
import { emptyTranscriptPage, highestEntryId, transcriptPage } from "./transcript.ts";
import { ApprovalDecisionSchema, TranscriptQuerySchema } from "./web-contract.ts";
import type {
  ApprovalDecision,
  BotView,
  PendingOperationView,
  TranscriptPage,
  TranscriptQuery,
} from "./web-contract.ts";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeManagedRuntime, type ManagedRuntime } from "./runtime.ts";
import { BotRegistryService } from "./services/bot-registry.ts";
import { createAuditLog } from "./audit-log.ts";
import type { AuditEvent, AuditLog } from "./audit-log.ts";

export interface Env {
  readonly Bot: DurableObjectNamespace<Bot>;
  readonly AI: Ai;
  readonly EXECUTOR_URL: string;
  readonly EXECUTOR_TOKEN: string;
  readonly OPENCODE_API_KEY: string;
  readonly CHAT_BEARER_TOKEN: string;
}

export interface WaitResult {
  readonly operationId: string;
  readonly session: string;
  readonly status: "done" | "unanswered" | "timeout";
  readonly text?: string;
  readonly reason?: string;
}

const HARNESS_SETTINGS: HarnessSettings = {
  progress: { partialIntervalMs: 1_000, outputIntervalMs: 1_000 },
  compaction: { enabled: true, reserveTokens: 16_384 },
};

const toThinkingLevel = (level: ThinkingLevel): ModelThinkingLevel =>
  level === "none" ? "off" : level;

const agentChange = (bot: BotConfig): AgentChange => {
  const model = resolveModelRef(bot);
  const target = { provider: model.provider, modelId: model.id };
  return bot.thinkingLevel === undefined
    ? { model: target, instructions: bot.systemPrompt }
    : {
        model: target,
        thinkingLevel: toThinkingLevel(bot.thinkingLevel),
        instructions: bot.systemPrompt,
      };
};

const conversationIdOf = (sessionId: string): ConversationId => {
  const id = Number(sessionId);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error(`invalid pi session id ${JSON.stringify(sessionId)}`);
  }
  // SAFETY: pi session ids are numeric conversation ids; validated above.
  return id as ConversationId;
};

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const makeHarnessFactory =
  (env: Env, botId: string, onPaused: PausedSink): PiHarnessFactory =>
  async ({ storage, context }) => {
    const registry = createRegistry();
    // The bridge detects the pause; `onPaused` turns it into the approval row.
    registry.install(
      createExecutorMcp(
        { url: env.EXECUTOR_URL, token: env.EXECUTOR_TOKEN },
        { onPaused },
      ),
    );
    registry.install(createBotDelegation({ env, sourceBotId: botId }));
    const models = createModels();
    models.setProvider(opencodeGoProvider());
    models.setProvider(createAI({ binding: env.AI }).provider);
    return Harness.open(storage, { models, registry, settings: HARNESS_SETTINGS }, context);
  };

export class Bot extends DurableObject<Env> {
  readonly lifecycle: Lifecycle<Env>;
  readonly harness: PiHarness;
  readonly streams: Streams;
  readonly runtime: ManagedRuntime<BotRegistryService, never>;
  #auditSink: AuditLog | undefined;
  #runStore: RunStore | undefined;
  #approvalStore: ApprovalStore | undefined;
  #feedService: Feed | undefined;
  #botReady: Promise<void> | undefined;
  /** In-flight thread→session creations, so concurrent requests share one. */
  readonly #threadSessions = new Map<string, Promise<string>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle = Lifecycle.install(this);
    this.harness = new PiHarness({
      harness: makeHarnessFactory(env, this.lifecycle.name, (paused) =>
        this.#recordPaused(paused),
      ),
    });
    this.streams = new Streams();
    this.lifecycle.use(this.harness);
    this.lifecycle.use(this.streams);
    this.runtime = makeManagedRuntime(BotRegistryService.layer);
  }

  /**
   * The lifecycle's `fetch` offers the request to its capabilities and then
   * falls through here, so this is where the DO's HTTP surface lives. RPC
   * methods (`submit`, `wait`, `status`) do not pass through it.
   */
  onRequest(request: Request): Promise<Response> {
    return this.#feed().serve(request);
  }

  async submit(
    text: string,
    operationId: string,
    whenBusy: PiWhenBusy,
    thread?: string,
    session?: string,
  ): Promise<PiReceipt> {
    await Effect.runPromise(Effect.tryPromise(() => this.lifecycle.start()));
    const sessionId =
      session ??
      (thread === undefined
        ? ROOT_SESSION
        : await Effect.runPromise(Effect.tryPromise(() => this.#sessionForThread(thread))));
    if (sessionId === ROOT_SESSION) {
      await Effect.runPromise(Effect.tryPromise(() => this.#ensureBot()));
    }
    // Attach before the submission is durable, so no harness event of the run
    // it admits can be produced before the watcher is listening.
    await this.#feed().attach(sessionId);
    // Read the entry high-water mark before admission, so the run's window
    // starts after everything pi had already written.
    const startEntry = await this.#entryMark(sessionId);
    const receipt = await Effect.runPromise(
      Effect.tryPromise(() =>
        this.harness.submit(text, { operationId, whenBusy, session: sessionId }),
      ),
    );
    if (receipt.accepted && startEntry !== undefined) {
      this.#runs().open({
        sessionId,
        operationId: receipt.operationId,
        inputs: [text],
        startedAt: Date.now(),
        startEntry,
      });
    }
    await this.#appendAudit({
      timestamp: Date.now(),
      botId: this.lifecycle.name,
      // An admitted replay is the only evidence that admission is at-most-once,
      // so it gets a row of its own instead of being dropped.
      kind: receipt.accepted ? "submission.accepted" : "submission.replayed",
      operationId,
      // Store a length, not the prompt text: the audit trail should not become
      // a second copy of everything a user sends.
      detail: { sessionId, textLength: text.length, origin: originOf(operationId) },
    });
    return receipt;
  }

  async wait(
    operationId: string,
    timeoutMs: number,
    session: string = ROOT_SESSION,
  ): Promise<WaitResult> {
    await Effect.runPromise(Effect.tryPromise(() => this.lifecycle.start()));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const outcome = await Effect.runPromise(
      Effect.tryPromise(() =>
        this.harness.wait(operationId, { session, signal: controller.signal }),
      ).pipe(
        Effect.match({
          onSuccess: (result) => ({ kind: "ok" as const, result }),
          onFailure: (cause) =>
            controller.signal.aborted
              ? { kind: "timeout" as const }
              : { kind: "fail" as const, cause },
        }),
      ),
    );
    clearTimeout(timer);
    if (outcome.kind === "timeout") {
      return { operationId, session, status: "timeout" };
    }
    if (outcome.kind === "fail") {
      throw outcome.cause;
    }
    const result = outcome.result;
    // `unanswered` means the target failed, aborted, or withdrew the operation,
    // so the settled outcome is worth recording whether or not it answered.
    await this.#appendAudit({
      timestamp: Date.now(),
      botId: this.lifecycle.name,
      kind: `settlement.${result.status}`,
      operationId: result.operationId,
      detail: {
        session: result.session,
        origin: originOf(result.operationId),
        reason: result.reason ?? null,
      },
    });
    await this.#settleRun(result.session, result.operationId);
    return {
      operationId: result.operationId,
      session: result.session,
      status: result.status,
      text: result.text,
      reason: result.reason,
    };
  }

  async status(): Promise<BotView> {
    await Effect.runPromise(Effect.tryPromise(() => this.lifecycle.start()));
    const id = this.lifecycle.name;
    const bot = await this.#botConfig();
    const [sessions, pending, usage] = await Effect.runPromise(
      Effect.all(
        [
          Effect.tryPromise(() => this.harness.sessions.list()),
          Effect.tryPromise(() => this.harness.pending()),
          Effect.tryPromise(() => this.#usage()),
        ],
        { concurrency: "unbounded" },
      ),
    );
    const pendingViews: readonly PendingOperationView[] = pending.map((operation) => ({
      operationId: operation.operationId,
      origin: originOf(operation.operationId),
      status: operation.status,
    }));
    const runs = this.#runs().list();
    const active = activeRunOf(pendingViews, runs);
    const cursor = active === undefined ? 0 : await this.#streamCursor(active.streamId);
    return projectStatus({
      id,
      model: resolveModelRef(bot),
      thinkingLevel: bot.thinkingLevel ?? null,
      // `sessions.list()` already reports each session's busy flag, so no
      // extra per-session `busy()` round trips are needed here.
      busy: sessions.some((session) => session.busy),
      pending: pendingViews,
      usage,
      approvals: this.#approvals().pending(),
      runs,
      activeRun: active === undefined ? undefined : { run: active, cursor },
    });
  }

  /**
   * Decide one pending approval: the decision is durable first, then the single
   * steer that has the model call `executor_resume`. `undefined` means there is
   * nothing left to decide, which the front door reports rather than replaying.
   */
  async decide(
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<DecidedApproval | undefined> {
    await Effect.runPromise(Effect.tryPromise(() => this.lifecycle.start()));
    return await this.#approvals().decide(
      approvalId,
      decision,
      // The steer is a submission like any other, so it goes through `submit`:
      // that is what gives it a run window, a stream and an audit row.
      (input, operationId, whenBusy, session) =>
        this.submit(input, operationId, whenBusy, undefined, session),
    );
  }

  /**
   * The transcript of one thread, paged backwards by entry id. A thread mackbot
   * has never created has no transcript yet, so this reads rather than creating
   * a session on a GET.
   */
  async transcript(query: TranscriptQuery): Promise<TranscriptPage> {
    await Effect.runPromise(Effect.tryPromise(() => this.lifecycle.start()));
    const thread = query.thread;
    if (thread !== undefined) {
      this.#ensureThreadsTable();
      const existing = this.#sessionIdForThread(thread);
      return existing === undefined
        ? emptyTranscriptPage(thread)
        : await this.#transcriptOf(existing, query);
    }
    return await this.#transcriptOf(ROOT_SESSION, query);
  }

  async #transcriptOf(session: string, query: TranscriptQuery): Promise<TranscriptPage> {
    const records = await Effect.runPromise(
      Effect.tryPromise(() => this.harness.messages({ session })),
    );
    const runs = this.#runs().list().filter((run) => run.sessionId === session);
    const latest = runs.at(-1);
    const cursor = latest === undefined ? 0 : await this.#streamCursor(latest.streamId);
    return transcriptPage(session, records, runs, query, streamViewOf(session, latest, cursor));
  }

  /**
   * The conversation's entries, or nothing when pi cannot read them. Admission's
   * bookkeeping must not fail a submission that has already landed, so a read
   * that fails costs the run its window, not the work.
   */
  async #messages(session: string): Promise<readonly EntryRecord[] | undefined> {
    return await Effect.runPromise(
      Effect.tryPromise(() => this.harness.messages({ session })).pipe(
        Effect.match({
          onSuccess: (records) => records,
          onFailure: (cause) => {
            console.error(
              `mackbot: transcript read for "${this.lifecycle.name}" failed: ${describeCause(cause)}`,
            );
            return undefined;
          },
        }),
      ),
    );
  }

  /** The conversation's next entry id: the run window's lower bound. */
  async #entryMark(session: string): Promise<number | undefined> {
    const records = await this.#messages(session);
    return records === undefined ? undefined : highestEntryId(records) + 1;
  }

  async #settleRun(session: string, operationId: string): Promise<void> {
    const records = await this.#messages(session);
    if (records === undefined) return;
    this.#runs().settle({
      sessionId: session,
      operationId,
      endEntry: highestEntryId(records),
      settledAt: Date.now(),
    });
  }

  /**
   * The newest chunk of a run's stream, or 0 before the bridge has written one:
   * the transcript route is what names the stream a client should attach to.
   */
  async #streamCursor(streamId: string): Promise<number> {
    const status = await Effect.runPromise(
      Effect.tryPromise(() => this.streams.status(streamId)).pipe(Effect.orElseSucceed(() => null)),
    );
    return status?.cursor ?? 0;
  }

  #runs(): RunStore {
    this.#runStore ??= createRunStore(this.ctx.storage);
    return this.#runStore;
  }

  #approvals(): ApprovalStore {
    this.#approvalStore ??= createApprovalStore(this.ctx.storage);
    return this.#approvalStore;
  }

  /**
   * The paused-call sink: the bridge found the pause, this records it. Recording
   * is idempotent on the requestId, so a second sighting of the same pause is
   * the same row.
   */
  #recordPaused(paused: PausedCall): void {
    this.#approvals().recordPaused({
      bot: this.lifecycle.name,
      session: paused.session,
      requestId: paused.requestId,
      envelope: paused.envelope,
    });
  }

  #feed(): Feed {
    this.#feedService ??= createFeed({
      botId: this.lifecycle.name,
      streams: this.streams,
      runs: this.#runs(),
      events: (session) => this.harness.session(session).events(BACKGROUND_CONTEXT),
      sessionOf: (thread) =>
        Promise.resolve(thread === undefined ? ROOT_SESSION : this.#sessionIdForThread(thread)),
    });
    return this.#feedService;
  }

  #ensureThreadsTable(): void {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS mackbot_threads (thread TEXT PRIMARY KEY, session_id TEXT NOT NULL)",
    );
  }

  #sessionIdForThread(thread: string): string | undefined {
    const rows = this.ctx.storage.sql
      .exec("SELECT session_id FROM mackbot_threads WHERE thread = ?", thread)
      .toArray();
    return rows.length > 0 ? String(rows[0].session_id) : undefined;
  }

  async #sessionForThread(thread: string): Promise<string> {
    // Serialize creation per thread: without this, two concurrent requests for
    // the same new thread both call `sessions.create()`, and the loser's
    // conversation is orphaned (pi conversations cannot be deleted yet).
    const inFlight = this.#threadSessions.get(thread);
    if (inFlight !== undefined) return inFlight;
    const task = this.#createSessionForThread(thread).finally(() => {
      this.#threadSessions.delete(thread);
    });
    this.#threadSessions.set(thread, task);
    return task;
  }

  async #createSessionForThread(thread: string): Promise<string> {
    this.#ensureThreadsTable();
    const existing = this.#sessionIdForThread(thread);
    if (existing !== undefined) return existing;

    await Effect.runPromise(Effect.tryPromise(() => this.#ensureBot()));
    const session = await Effect.runPromise(
      Effect.tryPromise(() => this.harness.sessions.create()),
    );
    const sessionId = session.id;
    const bot = await this.#botConfig();
    await Effect.runPromise(Effect.tryPromise(() => this.#configureSession(sessionId, bot)));
    // Defense in depth: if a row already exists (for example across isolates),
    // IGNORE + re-read keeps the first session id instead of throwing.
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO mackbot_threads (thread, session_id) VALUES (?, ?)",
      thread,
      sessionId,
    );
    return this.#sessionIdForThread(thread) ?? sessionId;
  }

  async #configureSession(sessionId: string, bot: BotConfig): Promise<void> {
    const pi = await Effect.runPromise(Effect.tryPromise(() => this.harness.pi()));
    const conversation = await Effect.runPromise(
      Effect.tryPromise(() => pi.conversation(conversationIdOf(sessionId), BACKGROUND_CONTEXT)),
    );
    if (conversation === undefined) {
      throw new Error(`session ${sessionId} not found`);
    }
    await Effect.runPromise(
      Effect.tryPromise(() => conversation.configure(agentChange(bot), BACKGROUND_CONTEXT)),
    );
  }

  async #botConfig(): Promise<BotConfig> {
    return this.runtime.runPromise(
      Effect.flatMap(BotRegistryService, (registry) => registry.getBot(this.lifecycle.name)),
    );
  }

  #ensureBot(): Promise<void> {
    this.#botReady ??= this.#applyBot().catch((cause: unknown) => {
      // Do not cache a rejected readiness promise: let the next call retry.
      this.#botReady = undefined;
      throw cause;
    });
    return this.#botReady;
  }

  async #applyBot(): Promise<void> {
    const bot = await this.#botConfig();
    const pi = await Effect.runPromise(Effect.tryPromise(() => this.harness.pi()));
    const root = await Effect.runPromise(Effect.tryPromise(() => pi.root(BACKGROUND_CONTEXT)));
    await Effect.runPromise(
      Effect.tryPromise(() => root.configure(agentChange(bot), BACKGROUND_CONTEXT)),
    );
  }

  /**
   * Audit write that never fails its caller. An unwritable audit trail must not
   * take down the operation it describes, but it must stay visible, so the cause
   * is logged the way `handleStatus` logs a failed bot status.
   */
  async #appendAudit(event: AuditEvent): Promise<void> {
    try {
      await this.#audit().append(event);
    } catch (cause) {
      console.error(
        `mackbot: audit write for "${this.lifecycle.name}" failed (${event.kind} ${event.operationId}): ${describeCause(cause)}`,
      );
    }
  }

  #audit(): AuditLog {
    if (this.#auditSink === undefined) {
      // SAFETY: DurableObjectStorage exposes SQLite storage compatible with AuditStorage.
      this.#auditSink = createAuditLog(this.ctx.storage as Parameters<typeof createAuditLog>[0]);
    }
    return this.#auditSink;
  }

  async #usage(): Promise<UsageState> {
    const pi = await Effect.runPromise(Effect.tryPromise(() => this.harness.pi()));
    return Effect.runPromise(Effect.tryPromise(() => pi.usage(BACKGROUND_CONTEXT)));
  }
}

const CHAT_ROUTE = /^\/chat\/([^/]+)$/u;
const EVENTS_ROUTE = /^\/events\/([^/]+)$/u;
const TRANSCRIPT_ROUTE = /^\/transcript\/([^/]+)$/u;
const APPROVAL_ROUTE = /^\/approvals\/([^/]+)\/([^/]+)$/u;

const methodNotAllowed = (): Response =>
  Response.json({ error: "method not allowed" }, { status: 405 });

const loadBotsEffect = (): Effect.Effect<Record<string, BotConfig>> =>
  Effect.flatMap(BotRegistryService, (registry) => registry.loadBots()).pipe(
    Effect.provide(BotRegistryService.layer),
  );

const handleChat = async (
  request: Request,
  env: Env,
  botId: string,
  immediate: boolean,
): Promise<Response> => {
  const bots = await Effect.runPromise(loadBotsEffect());
  if (!Object.hasOwn(bots, botId)) {
    return Response.json({ error: `unknown bot "${botId}"` }, { status: 404 });
  }
  const body = await readChatRequest(request);
  if (body === undefined) {
    return Response.json({ error: "invalid request body" }, { status: 400 });
  }
  const operationId = httpOperationId(body.operationId);
  const stub = env.Bot.getByName(botId);
  const receipt = await Effect.runPromise(
    Effect.tryPromise(() =>
      stub.submit(body.text, operationId, body.whenBusy ?? "followUp", body.thread),
    ),
  );
  // `wait=false` returns here; to fetch the result later, POST the same
  // operationId again (admission is at-most-once) and let it long-poll.
  if (immediate || body.wait === false) {
    return Response.json(
      { operationId: receipt.operationId, accepted: receipt.accepted },
      { status: 202 },
    );
  }
  const result = await Effect.runPromise(
    Effect.tryPromise(() => stub.wait(operationId, LONG_POLL_TIMEOUT_MS, receipt.session)),
  );
  if (result.status === "timeout") {
    return Response.json(
      { operationId, accepted: receipt.accepted, status: result.status },
      { status: 202 },
    );
  }
  return Response.json(result, { status: 200 });
};

interface BotStatusResult {
  readonly id: string;
  readonly status?: BotView;
  readonly error?: string;
}

const handleStatus = async (env: Env): Promise<Response> => {
  const bots = await Effect.runPromise(loadBotsEffect());
  const statusFor = (id: string): Effect.Effect<BotStatusResult> =>
    Effect.tryPromise(() => env.Bot.getByName(id).status()).pipe(
      Effect.map((status): BotStatusResult => ({ id, status })),
      Effect.catch((cause): Effect.Effect<BotStatusResult> => {
        // Log the real cause; return a generic message so internal error
        // strings (URLs, RPC details) never reach the client.
        console.error(`mackbot: status for "${id}" failed: ${describeCause(cause)}`);
        return Effect.succeed({ id, error: "status unavailable" });
      }),
    );
  const results = await Effect.runPromise(
    Effect.all(Object.keys(bots).map(statusFor), { concurrency: "unbounded" }),
  );
  const statuses: Record<string, BotView> = {};
  const errors: Record<string, string> = {};
  for (const entry of results) {
    if (entry.status === undefined) {
      errors[entry.id] = entry.error ?? "unknown error";
    } else {
      statuses[entry.id] = entry.status;
    }
  }
  return Response.json({ bots: statuses, errors });
};

const handleTranscript = async (url: URL, env: Env, botId: string): Promise<Response> => {
  const bots = await Effect.runPromise(loadBotsEffect());
  if (!Object.hasOwn(bots, botId)) {
    return Response.json({ error: `unknown bot "${botId}"` }, { status: 404 });
  }
  const query = await Effect.runPromise(
    Schema.decodeUnknownEffect(TranscriptQuerySchema)(Object.fromEntries(url.searchParams)).pipe(
      Effect.orElseSucceed(() => undefined),
    ),
  );
  if (query === undefined) {
    return Response.json({ error: "invalid query" }, { status: 400 });
  }
  const page = await Effect.runPromise(
    Effect.tryPromise(() => env.Bot.getByName(botId).transcript(query)),
  );
  return Response.json(page);
};

/**
 * The decision body, decoded with the contract's schema at the front door. An
 * unreadable or undecodable body is not a decision, so it is `undefined` rather
 * than a partial one.
 */
const readApprovalDecision = (request: Request): Promise<ApprovalDecision | undefined> =>
  Effect.runPromise(
    Effect.tryPromise(() => request.text()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ApprovalDecisionSchema))),
      Effect.orElseSucceed(() => undefined),
    ),
  );

const handleApproval = async (
  request: Request,
  env: Env,
  botId: string,
  approvalId: string,
): Promise<Response> => {
  const bots = await Effect.runPromise(loadBotsEffect());
  if (!Object.hasOwn(bots, botId)) {
    return Response.json({ error: `unknown bot "${botId}"` }, { status: 404 });
  }
  const decision = await readApprovalDecision(request);
  if (decision === undefined) {
    return Response.json({ error: "invalid request body" }, { status: 400 });
  }
  const decided = await Effect.runPromise(
    Effect.tryPromise(() => env.Bot.getByName(botId).decide(approvalId, decision)),
  );
  if (decided === undefined) {
    // Already decided, unknown, or not resumable: the human's decision must not
    // be replayed into a second resume.
    return Response.json({ error: "no pending approval" }, { status: 409 });
  }
  return Response.json(decided);
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (!isAuthorized(request, env.CHAT_BEARER_TOKEN)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const url = new URL(request.url);
      if (url.pathname === "/status") {
        return request.method === "GET" ? await handleStatus(env) : methodNotAllowed();
      }
      const match = CHAT_ROUTE.exec(url.pathname);
      if (match !== null) {
        return request.method === "POST"
          ? await handleChat(request, env, match[1]!, url.searchParams.get("wait") === "0")
          : methodNotAllowed();
      }
      const transcript = TRANSCRIPT_ROUTE.exec(url.pathname);
      if (transcript !== null) {
        return request.method === "GET"
          ? await handleTranscript(url, env, transcript[1]!)
          : methodNotAllowed();
      }
      const approval = APPROVAL_ROUTE.exec(url.pathname);
      if (approval !== null) {
        return request.method === "POST"
          ? await handleApproval(request, env, approval[1]!, approval[2]!)
          : methodNotAllowed();
      }
      const events = EVENTS_ROUTE.exec(url.pathname);
      if (events !== null) {
        // The stream's resume cursor lives in `Last-Event-ID` / `?from=`, so the
        // request reaches `sseResponse` intact through the DO's own `fetch`.
        return request.method === "GET"
          ? await env.Bot.getByName(events[1]!).fetch(request)
          : methodNotAllowed();
      }
      return Response.json({ error: "not found" }, { status: 404 });
    } catch (cause) {
      // Never leak a stack or internal detail: log the cause, return JSON.
      console.error(`mackbot: request failed: ${describeCause(cause)}`);
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const scheduledTime = controller.scheduledTime;
    const bots = await Effect.runPromise(loadBotsEffect());
    const admissions: Effect.Effect<void>[] = [];
    for (const [id, bot] of Object.entries(bots)) {
      const brief = bot.brief;
      if (brief === undefined) continue;
      admissions.push(
        Effect.tryPromise(() =>
          env.Bot.getByName(id).submit(brief, cronOperationId(id, scheduledTime), "followUp"),
        ).pipe(
          // One failing bot must not stop the others' briefs.
          Effect.catch((cause) => {
            console.error(`mackbot: cron brief for "${id}" failed: ${describeCause(cause)}`);
            return Effect.void;
          }),
        ),
      );
    }
    await Effect.runPromise(Effect.all(admissions, { concurrency: "unbounded" }));
  },
};
