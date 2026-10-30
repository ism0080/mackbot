import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { PiHarness, ROOT_SESSION } from "agents/harness/pi";
import type {
  PiHarnessFactory,
  PiPendingOperation,
  PiReceipt,
  PiWhenBusy,
} from "agents/harness/pi";
import { Streams } from "agents/streams";
import { createAI } from "agents/models/pi-ai";
import { Harness, LiveDoc, createRegistry } from "@earendil-works/pi-durable";
import type {
  AgentChange,
  Conversation,
  ConversationId,
  HarnessInspection,
  Registry as ExtensionRegistry,
  SubmissionId,
  SubmissionRecord,
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
import { voiceExtension } from "./voice.ts";
import { syncExtensions } from "./registry-sync.ts";
import { legacyThreadSession, recordThread, ThreadsDoc } from "./threads.ts";
import { createFailureStore } from "./failures.ts";
import type { FailureStore } from "./failures.ts";
import { projectTasks } from "./liveness.ts";
import { parkedTasks } from "./task-retry.ts";
import { settingsFor } from "./runtime-policy.ts";
import { createFeed } from "./feed.ts";
import type { Feed } from "./feed.ts";
import { abortOperationId, pausedCallAuditId } from "./operation.ts";
import { resolveModelRef } from "./bots.ts";
import type { BotConfig } from "./bots.ts";
import type { ThinkingLevel } from "@mackbot/contract/catalog";
import { createApprovalExtension, createApprovalStore, createApprovalWait } from "./approvals.ts";
import type { ApprovalStore, ApprovalWaitInput, DecidedApproval } from "./approvals.ts";
import { projectStatus } from "./status.ts";
import { emptyTranscriptPage, transcriptPage, transcriptRead } from "./transcript.ts";
import { generationFromStreamId, runProjections, streamTagFor } from "./feed.ts";
import { projectEntry, streamView } from "./projections.ts";
import { originOf } from "@mackbot/contract";
import type {
  AbortResult,
  ActiveRunView,
  ApprovalDecision,
  BotView,
  CompactResult,
  PendingOperationView,
  RetryResult,
  StreamStatusView,
  TranscriptPage,
  TranscriptQuery,
} from "@mackbot/contract";

import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";

import { BotRegistryService } from "./services/bot-registry.ts";
import { createAuditLog } from "./audit-log.ts";
import type { AuditEvent, AuditLog, AuditRecord } from "./audit-log.ts";
import type { Env, WaitResult } from "./env.ts";
import { describeCause } from "./errors.ts";
import { conversationIdOf, taskIdOf } from "./ids.ts";
import { toJson } from "./json.ts";

/** How many recent failures `/status` reports. A status page, not a history. */
const FAILURE_LIMIT = 10;

/** A session id that names no conversation of this bot. */
export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()("SessionNotFound", {
  session: Schema.String,
}) {}

/** A bot the registry does not declare: it has nothing to run with. */
export class BotNotDeclared extends Schema.TaggedError<BotNotDeclared>()("BotNotDeclared", {
  bot: Schema.String,
}) {}

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

export class Bot extends DurableObject<Env> {
  readonly lifecycle: Lifecycle<Env>;
  readonly harness: PiHarness;
  readonly streams: Streams;
  readonly runtime: ManagedRuntime.ManagedRuntime<BotRegistryService, never>;
  #auditSink: AuditLog | undefined;
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
  /**
   * The registry the harness runs on, kept so a roster change can install or
   * remove a per-bot extension without reopening the harness.
   */
  #registry: ExtensionRegistry | undefined;
  /**
   * The tail of the thread-session creation chain.
   *
   * A thread's session is looked up and then created, so two submits for the
   * same new thread must not both miss and both create. Creation is rare, so
   * serializing all of it - not just per thread - is cheap.
   */
  #sessionCreations: Promise<void> = Promise.resolve();

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
    this.runtime = ManagedRuntime.make(BotRegistryService.layerFor(env));
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
      this.#registry = registry;
      // The bridge detects the pause; `onPaused` turns it into the approval row.
      registry.install(
        createExecutorMcp({ url: env.EXECUTOR_URL, token: env.EXECUTOR_TOKEN }, { onPaused }),
      );
      // The chain of hand-offs rides in the operation ids of the inputs a run
      // answers, so delegation reads them to refuse a loop or a long chain.
      registry.install(
        createBotDelegation({
          env,
          sourceBotId: botId,
          submissions: (conversationId) => this.#submissionsOf(conversationId),
          audit: (record) => this.#record(record),
        }),
      );
      // The voice contract is fixed prose, not bot configuration: installing it
      // here rather than through `syncExtensions` means an already-seeded bot
      // gets it without its stored prompt being rewritten.
      registry.install(voiceExtension);
      registry.install(
        createExecutorPolicy({
          approvalState: (requestId) => this.#approvals().stateOf(requestId),
          claimResume: (requestId) => this.#approvals().claimResume(requestId),
          onCall: (call) => {
            void this.#appendAudit({
              timestamp: Date.now(),
              botId: this.lifecycle.name,
              kind: "executor.call",
              operationId: `executor:${call.name}`,
              detail: { tool: call.name, durationMs: call.durationMs },
            });
          },
          // A resume nobody vouched for is the harness overruling the model,
          // which is exactly what the trail is for.
          onRefused: (refusal) => {
            this.#record({
              kind: "approval.refused",
              // The model chose this id, so it is capped before it is stored.
              operationId: pausedCallAuditId((refusal.requestId ?? "(missing)").slice(0, 200)),
              detail: { reason: refusal.reason },
            });
          },
        }),
      );
      // Only the per-bot extensions are re-synced later; the wiring above is
      // installed once, when the harness opens.
      syncExtensions(registry, bot, { commitments: commitmentsExtension });
      // The store is built here, before `Harness.open`, so a wait a previous
      // isolate left behind finds it when the harness resumes its tasks. A
      // store created lazily on the first host call would be missing exactly
      // when a resumed wait needs it.
      registry.install(createApprovalExtension(this.#approvals()));
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
    await this.lifecycle.start();
    const sessionId =
      session ?? (thread === undefined ? ROOT_SESSION : await this.#sessionForThread(thread));
    await this.#applyConfiguration(sessionId);
    // Attach before the submission is durable, so no harness event of the run
    // it admits can be produced before the watcher is listening.
    await this.#feed().attach(sessionId);
    const receipt = await this.harness.submit(text, { operationId, whenBusy, session: sessionId });
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
    await this.lifecycle.start();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const outcome = await Effect.runPromise(
      Effect.tryPromise({
        try: () => this.harness.wait(operationId, { session, signal: controller.signal }),
        catch: (cause) => cause,
      }).pipe(
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
    await this.lifecycle.start();
    const pending = await this.harness.pending();
    const live = pending.filter((operation) => operation.session === session);
    await this.harness.session(session).abort();
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
    await this.lifecycle.start();
    const pi = await this.harness.pi();
    const inspection = await pi.inspect(BACKGROUND_CONTEXT);
    const parked = parkedTasks(inspection).find((task) => task.id === taskId);
    if (parked === undefined) {
      return { bot: this.lifecycle.name, taskId, retried: false };
    }
    const id = await Effect.runPromise(taskIdOf(taskId));
    await pi.retryTask(id, BACKGROUND_CONTEXT);
    await this.#appendAudit({
      timestamp: Date.now(),
      botId: this.lifecycle.name,
      kind: "task.retried",
      operationId: `retry:${taskId}`,
      detail: { taskId },
    });
    return { bot: this.lifecycle.name, taskId, retried: true };
  }

  /**
   * Compact one conversation by hand.
   *
   * pi summarizes while the conversation keeps working and places the summary
   * through a write submission: at once when idle, otherwise at the next
   * boundary. Nothing waits for it here, so the answer is the task a client can
   * follow in `pi.live.compactions` and in the transcript.
   */
  async compact(session: string = ROOT_SESSION, instructions?: string): Promise<CompactResult> {
    await this.lifecycle.start();
    const conversation = await this.#rootOrConversation(session);
    const taskId = String(await conversation.compact(instructions, BACKGROUND_CONTEXT));
    await this.#appendAudit({
      timestamp: Date.now(),
      botId: this.lifecycle.name,
      kind: "compaction.requested",
      operationId: `compact:${taskId}`,
      // A length, not the instructions: like a prompt, they are the user's text.
      detail: { session, instructionsLength: instructions?.length ?? 0 },
    });
    return { bot: this.lifecycle.name, taskId };
  }

  /**
   * The bot's status view. /status reads the whole roster before it asks
   * each bot, so it hands the bot its configuration rather than having every
   * bot ask the registry for it again; a caller without one leaves it out.
   */
  async status(config?: BotConfig): Promise<BotView> {
    await this.lifecycle.start();
    const id = this.lifecycle.name;
    const bot = config ?? (await this.#botConfig());
    const pi = await this.harness.pi();
    const [sessions, pending, usage, inspection] = await Promise.all([
      this.harness.sessions.list(),
      this.harness.pending(),
      this.#usage(),
      pi.inspect(BACKGROUND_CONTEXT),
    ]);
    const pendingViews: readonly PendingOperationView[] = pending.map((operation) => ({
      operationId: operation.operationId,
      origin: originOf(operation.operationId),
      status: operation.status,
    }));
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
      activeRun: await this.#activeRun(pending, inspection, pi),
      failures: this.#failures().recent(FAILURE_LIMIT),
      tasks: projectTasks(inspection),
    });
  }

  /**
   * The run in flight, as pi reports it.
   *
   * `pi.live.run` names the generation task and the submissions that run is
   * answering; the inspection holds that task's record, which is the only
   * durable start time there is. Nothing here is recorded beside those facts,
   * so a run that settles without a waiter cannot leave a stale row behind.
   */
  async #activeRun(
    pending: readonly PiPendingOperation[],
    inspection: HarnessInspection,
    pi: Harness,
  ): Promise<ActiveRunView | undefined> {
    const operation = pending.find((candidate) => candidate.status === "running") ?? pending[0];
    if (operation === undefined) return undefined;
    const session = operation.session;
    const conversationId = await Effect.runPromise(conversationIdOf(session));
    const live = await pi.snapshot(LiveDoc, conversationId, BACKGROUND_CONTEXT);
    const run = live?.run;
    const startedAt =
      run === undefined
        ? undefined
        : inspection.tasks.find((task) => task.record.id === run.taskId)?.record.startedAt;
    const stream = await this.#newestStream(session);
    return {
      ordinal: stream.generation,
      inputs: await this.#runInputs(pi, conversationId, run?.inputs, inspection),
      startedAt: startedAt ?? Date.now(),
      session,
      stream,
    };
  }

  /**
   * The prompt a run is answering, for the status row's title. The submission
   * that admitted it names the entry it was placed as, so the title is that
   * entry's model text and never a second copy of the request.
   */
  async #runInputs(
    pi: Harness,
    conversationId: ConversationId,
    inputs: readonly SubmissionId[] | undefined,
    inspection: HarnessInspection,
  ): Promise<readonly string[]> {
    const first = inputs?.[0];
    if (first === undefined) return [];
    const submission = inspection.submissions.find(
      (candidate) => String(candidate.id) === String(first),
    );
    const entryId = submission?.entry;
    if (entryId === undefined) return [];
    const conversation = await pi.conversation(conversationId, BACKGROUND_CONTEXT);
    if (conversation === undefined) return [];
    const page = await conversation.entries(
      { minEntryId: entryId, maxEntryId: entryId },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    );
    const entry = page.items[0];
    return entry === undefined ? [] : [projectEntry(entry).text];
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
    await this.lifecycle.start();
    return await this.#approvals().decide(
      approvalId,
      decision,
      // The steer is a submission like any other, so it goes through `submit`:
      // that is what gives it a stream, a run and an audit row.
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
    await this.lifecycle.start();
    const thread = query.thread;
    if (thread !== undefined) {
      const existing = await this.#sessionIdForThread(thread);
      return existing === undefined
        ? emptyTranscriptPage(thread)
        : await this.#transcriptOf(existing, query);
    }
    return await this.#transcriptOf(ROOT_SESSION, query);
  }

  async #transcriptOf(session: string, query: TranscriptQuery): Promise<TranscriptPage> {
    const conversationId = await Effect.runPromise(conversationIdOf(session));
    const pi = await this.harness.pi();
    const conversation = await pi.conversation(conversationId, BACKGROUND_CONTEXT);
    const read = transcriptRead(query);
    const page =
      conversation === undefined
        ? { items: [] as const }
        : await conversation.entries(read.query, read.limit, undefined, BACKGROUND_CONTEXT);
    return transcriptPage(
      session,
      page,
      runProjections(await this.#submissionsOf(conversationId)),
      query,
      await this.#newestStream(session),
    );
  }

  /**
   * The newest segment of a session's feed, or generation zero before the
   * bridge has opened one: the transcript route is what names the stream a
   * client should attach to.
   */
  async #newestStream(session: string): Promise<StreamStatusView> {
    const listed = await this.streams.list({
      tag: streamTagFor(this.lifecycle.name, session),
      limit: 1,
    });
    const newest = listed[0];
    return newest === undefined
      ? streamView(session, 0, 0, "completed")
      : streamView(
          session,
          generationFromStreamId(newest.streamId) ?? 0,
          newest.cursor,
          newest.state,
        );
  }

  /**
   * The conversation a session names. A session that names none fails with
   * {@link SessionNotFound} rather than resolving to nothing, so the caller
   * cannot mistake a missing conversation for an idle one.
   */
  #conversationOf(session: string): Promise<Conversation> {
    const harness = this.harness;
    return Effect.runPromise(
      Effect.gen(function* () {
        const id = yield* conversationIdOf(session);
        const pi = yield* Effect.tryPromise(() => harness.pi());
        const conversation = yield* Effect.tryPromise(() =>
          pi.conversation(id, BACKGROUND_CONTEXT),
        );
        if (conversation === undefined) return yield* new SessionNotFound({ session });
        return conversation;
      }),
    );
  }

  /** As {@link #conversationOf}, except that the root session is created when it is missing. */
  async #rootOrConversation(session: string): Promise<Conversation> {
    if (session !== ROOT_SESSION) return await this.#conversationOf(session);
    const pi = await this.harness.pi();
    return await pi.root(BACKGROUND_CONTEXT);
  }

  #approvals(): ApprovalStore {
    this.#approvalStore ??= createApprovalStore(this.ctx.storage, {
      // A pause leaves a durable wait behind, so a decision cannot be lost
      // between the row being written and the steer being submitted.
      // Returned, not voided: the store logs a rejected wait so a pause that
      // could not start its recovery task is not silent.
      startWait: (wait) => this.#startWait(wait),
      submit: (input, operationId, whenBusy, session) =>
        this.submit(input, operationId, whenBusy, undefined, session),
      audit: (record) => this.#record(record),
    });
    return this.#approvalStore;
  }

  /**
   * Start the durable wait for a recorded pause.
   *
   * The wait is a background task of the conversation the call paused in: it
   * must not hold that conversation's idle wait open, because a human may take
   * hours to answer. A pause in a conversation that no longer exists rejects
   * with {@link SessionNotFound}, which the approval store logs.
   */
  async #startWait(wait: ApprovalWaitInput): Promise<void> {
    const conversation = await this.#conversationOf(wait.session);
    await conversation.commit(
      (tx) =>
        tx.createTask(createApprovalWait(this.#approvals()), wait, {
          ownership: { kind: "conversation" },
          background: true,
        }),
      BACKGROUND_CONTEXT,
    );
  }

  /** The submissions of one conversation, as pi's inspection reports them. */
  async #submissionsOf(conversationId: ConversationId): Promise<readonly SubmissionRecord[]> {
    const pi = await this.harness.pi();
    const inspection = await pi.inspect(BACKGROUND_CONTEXT);
    return inspection.submissions.filter(
      (submission) => submission.conversationId === conversationId,
    );
  }

  /**
   * Drop what is past its retention: audit rows, recorded failures, and
   * approvals decided or expired long ago. The cron calls this for every bot,
   * so a bot nobody talks to does not keep growing its tables. It touches
   * only this instance's SQLite, so the harness is not started for it.
   */
  async prune(): Promise<void> {
    this.#audit().prune();
    this.#failures().prune();
    this.#approvals().prune();
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
      // pi's own view is the input: the whole active transcript plus the
      // documents a client renders, committed together, one callback per commit.
      watch: async (session) => {
        const conversation = await this.#conversationOf(session);
        return await conversation.watch(BACKGROUND_CONTEXT);
      },
      // A run's identity is pi's: each input submission names the entry it was
      // placed as and the entry that answered it.
      submissions: async (session) =>
        await this.#submissionsOf(await Effect.runPromise(conversationIdOf(session))),
      sessionOf: async (thread) =>
        thread === undefined ? ROOT_SESSION : await this.#sessionIdForThread(thread),
    });
    return this.#feedService;
  }

  /**
   * The legacy table, kept only for threads created before the thread document
   * existed. Nothing writes it any more.
   */
  #ensureThreadsTable(): void {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS mackbot_threads (thread TEXT PRIMARY KEY, session_id TEXT NOT NULL)",
    );
  }

  /**
   * The conversation a thread names.
   *
   * The document is the truth; the table only answers for a thread an older
   * isolate created, and a thread missing from both has no transcript yet.
   */
  async #sessionIdForThread(thread: string): Promise<string | undefined> {
    const pi = await this.harness.pi();
    const threads = await pi.snapshot(ThreadsDoc, BACKGROUND_CONTEXT);
    const recorded =
      threads !== undefined && Object.hasOwn(threads.threads, thread)
        ? threads.threads[thread]
        : undefined;
    if (recorded !== undefined) return recorded;
    this.#ensureThreadsTable();
    return legacyThreadSession(this.ctx.storage, thread);
  }

  /**
   * The session for a thread, creating one on first use.
   *
   * Every creation is serialized behind one chain, so the lookup and the
   * creation that follows a miss cannot interleave with another submit's for
   * the same thread.
   */
  #sessionForThread(thread: string): Promise<string> {
    const created = this.#sessionCreations.then(() => this.#createSessionForThread(thread));
    // A failed creation must not poison the chain for the next one.
    this.#sessionCreations = created.then(
      () => undefined,
      () => undefined,
    );
    return created;
  }

  async #createSessionForThread(thread: string): Promise<string> {
    const existing = await this.#sessionIdForThread(thread);
    if (existing !== undefined) return existing;
    const pi = await this.harness.pi();
    // The mapping is written by `init`, inside the commit that creates this
    // very conversation: a crash between the two cannot orphan it, and a
    // conversation something else creates meanwhile (the root, a delegated
    // subagent) can never be recorded as this thread's.
    const conversation = await pi.createConversation(
      {
        ownership: { kind: "ownerless" },
        init: (tx, id) => recordThread(tx, thread, String(id)),
      },
      BACKGROUND_CONTEXT,
    );
    return String(conversation.id);
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
    // The roster is read on every submit, so a flip of a per-bot extension
    // lands here: pi applies it at the next task phase or request.
    if (this.#registry !== undefined) {
      syncExtensions(this.#registry, bot, { commitments: commitmentsExtension });
    }
    // The configuration is a small object that is decoded the same way every
    // time, so its JSON text is a faithful comparison of two configurations.
    const applied = toJson(bot);
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
    const conversation = await this.#rootOrConversation(sessionId);
    await conversation.configure(agentChange(bot), BACKGROUND_CONTEXT);
    this.#applied.set(sessionId, applied);
  }

  /**
   * This bot's own configuration, as the registry holds it.
   *
   * The registry is the truth about who exists, so a bot that is not in it
   * has nothing to run with.
   */
  #botConfig(): Promise<BotConfig> {
    const name = this.lifecycle.name;
    return this.runtime.runPromise(
      Effect.flatMap(BotRegistryService, (registry) => registry.bot(name)).pipe(
        Effect.flatMap((bot) =>
          bot === undefined ? Effect.fail(new BotNotDeclared({ bot: name })) : Effect.succeed(bot),
        ),
      ),
    );
  }

  /**
   * The audit sink the seams outside this class report through: the row is
   * stamped here, and written behind the caller so a slow or failed write never
   * holds up the approval or the delegation it describes.
   */
  #record(record: AuditRecord): void {
    void this.#appendAudit({ timestamp: Date.now(), botId: this.lifecycle.name, ...record });
  }

  /**
   * Audit write that never fails its caller. An unwritable audit trail must not
   * take down the operation it describes, but it must stay visible, so the cause
   * is logged the way `handleStatus` logs a failed bot status.
   */
  #appendAudit(event: AuditEvent): Promise<void> {
    return Effect.runPromise(
      Effect.tryPromise({
        try: async () => this.#audit().append(event),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            console.error(
              `mackbot: audit write for "${this.lifecycle.name}" failed (${event.kind} ${event.operationId}): ${describeCause(cause)}`,
            );
          }),
        ),
      ),
    );
  }

  #audit(): AuditLog {
    if (this.#auditSink === undefined) {
      // SAFETY: DurableObjectStorage exposes SQLite storage compatible with AuditStorage.
      this.#auditSink = createAuditLog(this.ctx.storage as Parameters<typeof createAuditLog>[0]);
    }
    return this.#auditSink;
  }

  async #usage(): Promise<UsageState> {
    const pi = await this.harness.pi();
    return pi.usage(BACKGROUND_CONTEXT);
  }
}
