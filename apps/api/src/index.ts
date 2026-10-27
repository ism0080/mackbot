import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { PiHarness, ROOT_SESSION } from "agents/harness/pi";
import type { PiHarnessFactory, PiReceipt, PiWhenBusy } from "agents/harness/pi";
import { Streams } from "agents/streams";
import { createAI } from "agents/models/pi-ai";
import { Harness, createRegistry, defineExtension } from "@earendil-works/pi-durable";
import type {
  AgentChange,
  ConversationId,
  EntryRecord,
  TaskId,
  UsageState,
} from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createExecutorMcp } from "./executor-mcp.ts";
import type { PausedCall, PausedSink } from "./executor-mcp.ts";
import { createExecutorPolicy } from "./executor-policy.ts";
import { createBotDelegation } from "./bot-delegation.ts";
import { commitmentsExtension } from "./commitments.ts";
import { createFailureStore } from "./failures.ts";
import type { FailureStore } from "./failures.ts";
import { projectTasks } from "./liveness.ts";
import { parkedTasks } from "./task-retry.ts";
import { settingsFor } from "./runtime-policy.ts";
import { createFeed } from "./feed.ts";
import type { Feed } from "./feed.ts";
import { cronOperationId, httpOperationId, abortOperationId } from "./operation.ts";
import { readChatRequest, tokensMatch } from "./chat-request.ts";
import { loginDocument } from "./login-page.ts";
import { authenticate, csrfAllows, issueSession, sessionCookie } from "./session.ts";
import { LONG_POLL_TIMEOUT_MS } from "./constants.ts";
import { resolveModelRef } from "./bots.ts";
import type { BotConfig } from "./bots.ts";
import { MODEL_VARIANTS } from "@mackbot/contract/catalog";
import type { ThinkingLevel } from "@mackbot/contract/catalog";
import { ApprovalWait, createApprovalStore } from "./approvals.ts";
import type { ApprovalStore, ApprovalWaitInput, DecidedApproval } from "./approvals.ts";
import { createRunStore, streamViewOf } from "./runs.ts";
import type { RunStore } from "./runs.ts";
import { activeRunOf, projectStatus } from "./status.ts";
import { emptyTranscriptPage, highestEntryId, transcriptPage } from "./transcript.ts";
import {
  AbortRequestSchema,
  ApprovalDecisionSchema,
  BotCreateSchema,
  BotWriteSchema,
  originOf,
  RetryRequestSchema,
  TranscriptQuerySchema,
} from "@mackbot/contract";
import type {
  AbortRequest,
  AbortResult,
  ApprovalDecision,
  BotCreate,
  BotView,
  BotWrite,
  PendingOperationView,
  RetryRequest,
  RetryResult,
  TranscriptPage,
  TranscriptQuery,
} from "@mackbot/contract";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeManagedRuntime, type ManagedRuntime } from "./runtime.ts";
import { BotRegistryService } from "./services/bot-registry.ts";
import { Registry } from "./registry.ts";
import type { RegistryWrite } from "./registry-store.ts";
import { createAuditLog } from "./audit-log.ts";
import type { AuditEvent, AuditLog } from "./audit-log.ts";

/**
 * The Worker entry module is where Cloudflare looks for a Durable Object
 * class, and the class name has to match the binding name.
 */
export { Registry };

export interface Env {
  readonly Bot: DurableObjectNamespace<Bot>;
  readonly Registry: DurableObjectNamespace<Registry>;
  readonly AI: Ai;
  readonly ASSETS: Fetcher;
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

/** How many recent failures `/status` reports. A status page, not a history. */
const FAILURE_LIMIT = 10;

const toThinkingLevel = (level: ThinkingLevel): ModelThinkingLevel =>
  level === "none" ? "off" : level;

const agentChange = (bot: BotConfig): AgentChange => {
  const model = resolveModelRef(bot);
  const target = { provider: model.provider, modelId: model.id };
  return {
    model: target,
    // pi's `applyChange` skips `undefined` and deletes on `null`, so a bot
    // that declares no level has to send `null`: an omitted level would leave
    // the old one in place, and a person who removes the level in the browser
    // would not see it take effect.
    thinkingLevel: bot.thinkingLevel === undefined ? null : toThinkingLevel(bot.thinkingLevel),
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

/** pi's task id, which the view carries as a string. */
const taskIdOf = (taskId: string): TaskId => {
  const id = Number(taskId);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error(`invalid pi task id ${JSON.stringify(taskId)}`);
  }
  // SAFETY: pi task ids are numeric task ids; validated above.
  return id as TaskId;
};

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export class Bot extends DurableObject<Env> {
  readonly lifecycle: Lifecycle<Env>;
  readonly harness: PiHarness;
  readonly streams: Streams;
  readonly runtime: ManagedRuntime<BotRegistryService, never>;
  #auditSink: AuditLog | undefined;
  #runStore: RunStore | undefined;
  #approvalStore: ApprovalStore | undefined;
  #failureStore: FailureStore | undefined;
  #feedService: Feed | undefined;
  /**
   * The configuration each session was last configured with, by session id.
   *
   * The comparison is the configuration's own text, so there is no version
   * counter to keep in step with the roster.
   */
  readonly #applied = new Map<string, string>();
  /**
   * The configuration the bot last loaded from the registry. The harness
   * reads its settings at every use, so the run policy is computed from this
   * rather than from one settings object captured when the harness opened.
   */
  #loaded: BotConfig | undefined;
  /** In-flight thread→session creations, so concurrent requests share one. */
  readonly #threadSessions = new Map<string, Promise<string>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle = Lifecycle.install(this);
    this.harness = new PiHarness({
      harness: this.#makeHarnessFactory(env, this.lifecycle.name, (paused) =>
        this.#recordPaused(paused),
      ),
    });
    this.streams = new Streams();
    this.lifecycle.use(this.harness);
    this.lifecycle.use(this.streams);
    this.runtime = makeManagedRuntime(BotRegistryService.layerFor(env));
  }

  /**
   * The harness this bot runs on: its registry, its models and its run policy.
   *
   * The policy comes from the bot's own declaration rather than one settings
   * object shared by the whole fleet, so a bot that knows its context window
   * compacts at thresholds that suit it. The registry carries the Executor
   * bridge, the delegation tool, the approval policy and, for a bot that
   * declares commitments, the commitments extension.
   *
   * The harness reports what it could not recover from; the failure store
   * keeps it, so `/status` can show it.
   */
  #makeHarnessFactory(env: Env, botId: string, onPaused: PausedSink): PiHarnessFactory {
    return async ({ storage, context }) => {
      const bot = await this.#botConfig();
      this.#loaded = bot;
      const registry = createRegistry();
      // The bridge detects the pause; `onPaused` turns it into the approval row.
      registry.install(
        createExecutorMcp({ url: env.EXECUTOR_URL, token: env.EXECUTOR_TOKEN }, { onPaused }),
      );
      registry.install(createBotDelegation({ env, sourceBotId: botId }));
      registry.install(
        createExecutorPolicy({
          approvalState: (requestId) => this.#approvals().stateOf(requestId),
          onCall: (call) => {
            void this.#appendAudit({
              timestamp: Date.now(),
              botId: this.lifecycle.name,
              kind: "executor.call",
              operationId: `executor:${call.name}`,
              detail: { tool: call.name, durationMs: call.durationMs },
            });
          },
        }),
      );
      if (bot.commitments === true) registry.install(commitmentsExtension);
      registry.install(defineExtension({ name: "mackbot-approvals", tasks: [ApprovalWait] }));
      const models = createModels();
      models.setProvider(opencodeGoProvider());
      models.setProvider(createAI({ binding: env.AI }).provider);
      return Harness.open(
        storage,
        {
          models,
          registry,
          // pi reads the settings at every use when it is given a function,
          // so the run policy follows the configuration the bot last loaded:
          // a `runtime` edit lands without reopening the harness.
          settings: () => settingsFor(this.#loaded ?? bot),
          onReport: (cause, info) => {
            this.#failures().record(cause, info);
          },
        },
        context,
      );
    };
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
    await Effect.runPromise(Effect.tryPromise(() => this.#applyConfiguration(sessionId)));
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

  /**
   * Stop a session's current work.
   *
   * pi withdraws the session's queued inputs and aborts its running work; the
   * call resolves once the session is idle. `aborted` says whether there was
   * anything to stop, because pi's own abort answers true for an idle session
   * too and an idle bot must not look like it did something.
   */
  async abort(session: string = ROOT_SESSION): Promise<AbortResult> {
    await Effect.runPromise(Effect.tryPromise(() => this.lifecycle.start()));
    const pending = await Effect.runPromise(Effect.tryPromise(() => this.harness.pending()));
    const live = pending.filter((operation) => operation.session === session);
    await Effect.runPromise(Effect.tryPromise(() => this.harness.session(session).abort()));
    await this.#appendAudit({
      timestamp: Date.now(),
      botId: this.lifecycle.name,
      kind: "session.aborted",
      operationId: abortOperationId(session),
      detail: { session, stopped: live.length },
    });
    return { bot: this.lifecycle.name, session, aborted: live.length > 0 };
  }

  /**
   * Run a parked task again.
   *
   * pi parks a task that was cut off too many times in a row, and refuses to
   * run it until somebody says so. The answer says whether there was anything
   * parked under that id, because a task that was never parked cannot be
   * retried and the caller should not be told otherwise.
   */
  async retry(taskId: string): Promise<RetryResult> {
    await Effect.runPromise(Effect.tryPromise(() => this.lifecycle.start()));
    const pi = await Effect.runPromise(Effect.tryPromise(() => this.harness.pi()));
    const inspection = await Effect.runPromise(
      Effect.tryPromise(() => pi.inspect(BACKGROUND_CONTEXT)),
    );
    const parked = parkedTasks(inspection).find((task) => task.id === taskId);
    if (parked === undefined) {
      return { bot: this.lifecycle.name, taskId, retried: false };
    }
    await Effect.runPromise(
      Effect.tryPromise(() => pi.retryTask(taskIdOf(taskId), BACKGROUND_CONTEXT)),
    );
    await this.#appendAudit({
      timestamp: Date.now(),
      botId: this.lifecycle.name,
      kind: "task.retried",
      operationId: `retry:${taskId}`,
      detail: { taskId },
    });
    return { bot: this.lifecycle.name, taskId, retried: true };
  }

  async status(): Promise<BotView> {
    await Effect.runPromise(Effect.tryPromise(() => this.lifecycle.start()));
    const id = this.lifecycle.name;
    const bot = await this.#botConfig();
    const pi = await Effect.runPromise(Effect.tryPromise(() => this.harness.pi()));
    const [sessions, pending, usage, inspection] = await Effect.runPromise(
      Effect.all(
        [
          Effect.tryPromise(() => this.harness.sessions.list()),
          Effect.tryPromise(() => this.harness.pending()),
          Effect.tryPromise(() => this.#usage()),
          Effect.tryPromise(() => pi.inspect(BACKGROUND_CONTEXT)),
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
      failures: this.#failures().recent(FAILURE_LIMIT),
      tasks: projectTasks(inspection),
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
    const runs = this.#runs()
      .list()
      .filter((run) => run.sessionId === session);
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
    this.#approvalStore ??= createApprovalStore(this.ctx.storage, {
      // A pause leaves a durable wait behind, so a decision cannot be lost
      // between the row being written and the steer being submitted.
      startWait: (wait) => {
        void this.#startWait(wait);
      },
      submit: (input, operationId, whenBusy, session) =>
        this.submit(input, operationId, whenBusy, undefined, session),
    });
    return this.#approvalStore;
  }

  /**
   * Start the durable wait for a recorded pause.
   *
   * The wait is a background task of the conversation the call paused in: it
   * must not hold that conversation's idle wait open, because a human may take
   * hours to answer.
   */
  async #startWait(wait: ApprovalWaitInput): Promise<void> {
    const pi = await Effect.runPromise(Effect.tryPromise(() => this.harness.pi()));
    const conversation = await Effect.runPromise(
      Effect.tryPromise(() => pi.conversation(conversationIdOf(wait.session), BACKGROUND_CONTEXT)),
    );
    if (conversation === undefined) return;
    await Effect.runPromise(
      Effect.tryPromise(() =>
        conversation.commit(
          (tx) =>
            tx.createTask(ApprovalWait, wait, {
              ownership: { kind: "conversation" },
              background: true,
            }),
          BACKGROUND_CONTEXT,
        ),
      ),
    );
  }

  #failures(): FailureStore {
    this.#failureStore ??= createFailureStore(this.ctx.storage);
    return this.#failureStore;
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

    const session = await Effect.runPromise(
      Effect.tryPromise(() => this.harness.sessions.create()),
    );
    const sessionId = session.id;
    // Defense in depth: if a row already exists (for example across isolates),
    // IGNORE + re-read keeps the first session id instead of throwing.
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO mackbot_threads (thread, session_id) VALUES (?, ?)",
      thread,
      sessionId,
    );
    return this.#sessionIdForThread(thread) ?? sessionId;
  }

  /**
   * Configure the conversations a submit touches, when the configuration has
   * changed.
   *
   * The root conversation is configured first, the way it always was, and then
   * the session the submit names, so a thread session gets its own
   * configuration. A thread session that is new has no applied configuration,
   * so the same path configures it.
   */
  async #applyConfiguration(sessionId: string): Promise<void> {
    const bot = await this.#botConfig();
    this.#loaded = bot;
    // The configuration is a small object that is decoded the same way every
    // time, so its JSON text is a faithful comparison of two configurations.
    const applied = JSON.stringify(bot);
    await this.#configure(ROOT_SESSION, bot, applied);
    if (sessionId !== ROOT_SESSION) {
      await this.#configure(sessionId, bot, applied);
    }
  }

  /**
   * Configure one session, unless it already runs the configuration the bot
   * has just loaded.
   */
  async #configure(sessionId: string, bot: BotConfig, applied: string): Promise<void> {
    if (this.#applied.get(sessionId) === applied) return;
    await this.#configureSession(sessionId, bot);
    this.#applied.set(sessionId, applied);
  }

  async #configureSession(sessionId: string, bot: BotConfig): Promise<void> {
    const pi = await Effect.runPromise(Effect.tryPromise(() => this.harness.pi()));
    const conversation =
      sessionId === ROOT_SESSION
        ? await Effect.runPromise(Effect.tryPromise(() => pi.root(BACKGROUND_CONTEXT)))
        : await Effect.runPromise(
            Effect.tryPromise(() =>
              pi.conversation(conversationIdOf(sessionId), BACKGROUND_CONTEXT),
            ),
          );
    if (conversation === undefined) {
      throw new Error(`session ${sessionId} not found`);
    }
    await Effect.runPromise(
      Effect.tryPromise(() => conversation.configure(agentChange(bot), BACKGROUND_CONTEXT)),
    );
  }

  /**
   * This bot's own configuration, as the registry holds it.
   *
   * The registry is the truth about who exists, so a bot that is not in it
   * has nothing to run with.
   */
  async #botConfig(): Promise<BotConfig> {
    const bot = await this.runtime.runPromise(
      Effect.flatMap(BotRegistryService, (registry) => registry.bot(this.lifecycle.name)),
    );
    if (bot === undefined) {
      throw new Error(`no bot "${this.lifecycle.name}" in the registry`);
    }
    return bot;
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
const ABORT_ROUTE = /^\/abort\/([^/]+)$/u;
const RETRY_ROUTE = /^\/retry\/([^/]+)$/u;
const BOT_ROUTE = /^\/bots\/([^/]+)$/u;

const methodNotAllowed = (): Response =>
  Response.json({ error: "method not allowed" }, { status: 405 });

const LoginFormSchema = Schema.Struct({ token: Schema.NonEmptyString });

const readLoginToken = async (request: Request): Promise<string | undefined> => {
  const form = await Effect.runPromise(
    Effect.tryPromise(() => request.formData()).pipe(Effect.orElseSucceed(() => undefined)),
  );
  if (form === undefined) return undefined;
  return Effect.runPromise(
    Schema.decodeUnknownEffect(LoginFormSchema)(Object.fromEntries(form)).pipe(
      Effect.map((body) => body.token),
      Effect.orElseSucceed(() => undefined),
    ),
  );
};

const handleLogin = async (request: Request, env: Env): Promise<Response> => {
  if (request.method === "GET") {
    return new Response(loginDocument(false), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }
  if (request.method !== "POST") return methodNotAllowed();
  const token = await readLoginToken(request);
  if (token === undefined || !tokensMatch(token, env.CHAT_BEARER_TOKEN)) {
    return new Response(loginDocument(true), {
      status: 401,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const value = await Effect.runPromise(issueSession(env.CHAT_BEARER_TOKEN, Date.now()));
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": sessionCookie(request, value),
      "cache-control": "no-store",
    },
  });
};

const isMutation = (request: Request): boolean =>
  request.method !== "GET" && request.method !== "HEAD";

const API_ROUTES = [
  CHAT_ROUTE,
  EVENTS_ROUTE,
  TRANSCRIPT_ROUTE,
  APPROVAL_ROUTE,
  ABORT_ROUTE,
  RETRY_ROUTE,
  BOT_ROUTE,
];

/**
 * The paths that answer with JSON rather than with the login page.
 *
 * The registry's own routes are API routes: a browser that asks for the
 * roster without a credential is a broken client, not a navigation, and a
 * redirect would decode as one.
 */
const API_PATHS = new Set(["/status", "/bots", "/models"]);

const isApiRoute = (pathname: string): boolean =>
  API_PATHS.has(pathname) || API_ROUTES.some((route) => route.test(pathname));

/**
 * The refusal for a request that may not continue, or `undefined` when it may.
 * A browser navigation without a credential is sent to the login page; an API
 * call gets JSON, because a redirect would decode as a broken response.
 */
// Paths that must be reachable without a session, because the browser or the
// operating system fetches them before it can authenticate: the manifest the
// install prompt reads, the icons the home screen uses, and the favicon.
const PUBLIC_ASSETS = new Set([
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
  "/favicon.ico",
]);

const authorize = async (request: Request, env: Env): Promise<Response | undefined> => {
  const url = new URL(request.url);
  if (PUBLIC_ASSETS.has(url.pathname)) return undefined;
  const method = await Effect.runPromise(authenticate(request, env.CHAT_BEARER_TOKEN));
  if (method === undefined) {
    return isApiRoute(url.pathname) || isMutation(request)
      ? Response.json({ error: "unauthorized" }, { status: 401 })
      : Response.redirect(new URL("/login", request.url).toString(), 302);
  }
  if (method === "cookie" && isMutation(request) && !csrfAllows(request)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  return undefined;
};

/**
 * The roster, read through the registry.
 *
 * The registry is the truth about who exists, so every route that asks
 * whether a bot is there asks the registry and not a module cache.
 */
const rosterEffect = (env: Env): Effect.Effect<Record<string, BotConfig>> =>
  Effect.flatMap(BotRegistryService, (registry) => registry.roster()).pipe(
    Effect.provide(BotRegistryService.layerFor(env)),
  );

/** The one write, through the registry. */
const writeEffect = (
  env: Env,
  name: string,
  bot: BotConfig,
  mode: "create" | "replace",
): Effect.Effect<RegistryWrite> =>
  Effect.flatMap(BotRegistryService, (registry) => registry.write(name, bot, mode)).pipe(
    Effect.provide(BotRegistryService.layerFor(env)),
  );

const handleChat = async (
  request: Request,
  env: Env,
  botId: string,
  immediate: boolean,
): Promise<Response> => {
  const bots = await Effect.runPromise(rosterEffect(env));
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
  const bots = await Effect.runPromise(rosterEffect(env));
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
  const bots = await Effect.runPromise(rosterEffect(env));
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

/**
 * The stop's body. An empty body stops the bot's root session, so an empty
 * body is a valid request rather than a bad one.
 */
const readAbortRequest = async (request: Request): Promise<AbortRequest | undefined> => {
  const raw = await Effect.runPromise(
    Effect.tryPromise(() => request.text()).pipe(Effect.orElseSucceed(() => "")),
  );
  const body = raw.trim().length === 0 ? "{}" : raw;
  return await Effect.runPromise(
    Schema.decodeUnknownEffect(Schema.fromJsonString(AbortRequestSchema))(body).pipe(
      Effect.orElseSucceed(() => undefined),
    ),
  );
};

/** The retry's body: which task to run again. */
const readRetryRequest = async (request: Request): Promise<RetryRequest | undefined> => {
  const raw = await Effect.runPromise(
    Effect.tryPromise(() => request.text()).pipe(Effect.orElseSucceed(() => "")),
  );
  return await Effect.runPromise(
    Schema.decodeUnknownEffect(Schema.fromJsonString(RetryRequestSchema))(raw).pipe(
      Effect.orElseSucceed(() => undefined),
    ),
  );
};

const handleApproval = async (
  request: Request,
  env: Env,
  botId: string,
  approvalId: string,
): Promise<Response> => {
  const bots = await Effect.runPromise(rosterEffect(env));
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

/**
 * Stop a bot's current work. The body is optional: an empty body stops the
 * bot's root session. A stop is a mutation, so it goes through the same
 * authorization and CSRF gate as any other.
 */
const handleAbort = async (request: Request, env: Env, botId: string): Promise<Response> => {
  const bots = await Effect.runPromise(rosterEffect(env));
  if (!Object.hasOwn(bots, botId)) {
    return Response.json({ error: `unknown bot "${botId}"` }, { status: 404 });
  }
  const body = await readAbortRequest(request);
  if (body === undefined) {
    return Response.json({ error: "invalid request body" }, { status: 400 });
  }
  const result = await Effect.runPromise(
    Effect.tryPromise(() => env.Bot.getByName(botId).abort(body.session)),
  );
  return Response.json(result);
};

/**
 * Run a parked task again. The harness parks a task that was cut off too many
 * times in a row, so a bot that was crashing in a loop can be given another
 * chance without waiting for the crash limit to expire.
 */
const handleRetry = async (request: Request, env: Env, botId: string): Promise<Response> => {
  const bots = await Effect.runPromise(rosterEffect(env));
  if (!Object.hasOwn(bots, botId)) {
    return Response.json({ error: `unknown bot "${botId}"` }, { status: 404 });
  }
  const body = await readRetryRequest(request);
  if (body === undefined) {
    return Response.json({ error: "invalid request body" }, { status: 400 });
  }
  const result = await Effect.runPromise(
    Effect.tryPromise(() => env.Bot.getByName(botId).retry(body.taskId)),
  );
  return Response.json(result);
};

/**
 * The roster: every bot the fleet runs, as the browser edits it.
 */
const handleRoster = async (env: Env): Promise<Response> => {
  const bots = await Effect.runPromise(rosterEffect(env));
  return Response.json({ bots });
};

/**
 * The models the Worker knows, and the thinking levels each one supports.
 *
 * The catalog lives in the Worker, so it crosses the wire rather than
 * reaching the browser's module graph: the browser offers a picker, and the
 * Worker is what knows which models exist.
 */
const handleModels = (): Response => Response.json({ models: MODEL_VARIANTS });

/**
 * The create's body: the id to give the new bot, and its whole configuration.
 *
 * A body that does not decode is not a create, so the registry never sees it.
 */
const readBotCreate = (request: Request): Promise<BotCreate | undefined> =>
  Effect.runPromise(
    Effect.tryPromise(() => request.text()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(BotCreateSchema))),
      Effect.orElseSucceed(() => undefined),
    ),
  );

/** The write's body: the whole configuration of one bot. */
const readBotWrite = (request: Request): Promise<BotWrite | undefined> =>
  Effect.runPromise(
    Effect.tryPromise(() => request.text()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(BotWriteSchema))),
      Effect.orElseSucceed(() => undefined),
    ),
  );

/**
 * A refused write, in the status code its refusal means: a rule's own message
 * for a bot that breaks a rule, a 404 for a bot that is not there and a 409
 * for one that already is.
 */
const writeRefusal = (refusal: RegistryWrite & { readonly ok: false }): Response => {
  switch (refusal.code) {
    case "invalid":
      return Response.json({ error: refusal.error }, { status: 400 });
    case "unknown":
      return Response.json({ error: refusal.error }, { status: 404 });
    case "exists":
      return Response.json({ error: refusal.error }, { status: 409 });
  }
};

/**
 * Add a bot. The body carries the id to give the new bot and the whole
 * configuration it runs with.
 */
const handleBotCreate = async (request: Request, env: Env): Promise<Response> => {
  const body = await readBotCreate(request);
  if (body === undefined) {
    return Response.json({ error: "invalid request body" }, { status: 400 });
  }
  const result = await Effect.runPromise(writeEffect(env, body.id, body.bot, "create"));
  if (!result.ok) return writeRefusal(result);
  return Response.json({ id: body.id, bot: result.roster[body.id] }, { status: 201 });
};

/**
 * Replace a bot's configuration. The body carries the whole configuration, so
 * the fields the form does not show survive the round trip.
 */
const handleBotWrite = async (request: Request, env: Env, botId: string): Promise<Response> => {
  const body = await readBotWrite(request);
  if (body === undefined) {
    return Response.json({ error: "invalid request body" }, { status: 400 });
  }
  const result = await Effect.runPromise(writeEffect(env, botId, body.bot, "replace"));
  if (!result.ok) return writeRefusal(result);
  return Response.json({ id: botId, bot: result.roster[botId] });
};

/**
 * The registry's own routes: the roster, the models the Worker knows, and a
 * bot's configuration.
 *
 * `undefined` means the path is not one of them.
 */
const handleRegistryRoute = async (
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | undefined> => {
  if (url.pathname === "/bots") {
    if (request.method === "GET") return await handleRoster(env);
    return request.method === "POST" ? await handleBotCreate(request, env) : methodNotAllowed();
  }
  if (url.pathname === "/models") {
    return request.method === "GET" ? handleModels() : methodNotAllowed();
  }
  const bot = BOT_ROUTE.exec(url.pathname);
  if (bot === null) return undefined;
  return request.method === "PUT"
    ? await handleBotWrite(request, env, bot[1]!)
    : methodNotAllowed();
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/login") {
        return await handleLogin(request, env);
      }
      const refusal = await authorize(request, env);
      if (refusal !== undefined) return refusal;
      if (url.pathname === "/status") {
        return request.method === "GET" ? await handleStatus(env) : methodNotAllowed();
      }
      const registry = await handleRegistryRoute(request, env, url);
      if (registry !== undefined) return registry;
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
      const abort = ABORT_ROUTE.exec(url.pathname);
      if (abort !== null) {
        return request.method === "POST"
          ? await handleAbort(request, env, abort[1]!)
          : methodNotAllowed();
      }
      const retry = RETRY_ROUTE.exec(url.pathname);
      if (retry !== null) {
        return request.method === "POST"
          ? await handleRetry(request, env, retry[1]!)
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
      // Everything that is not this Worker's own route is the built app. The
      // assets binding applies the SPA fallback for a deep link.
      return await env.ASSETS.fetch(request);
    } catch (cause) {
      // Never leak a stack or internal detail: log the cause, return JSON.
      console.error(`mackbot: request failed: ${describeCause(cause)}`);
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const scheduledTime = controller.scheduledTime;
    const bots = await Effect.runPromise(rosterEffect(env));
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
