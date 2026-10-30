/**
 * bot-delegation — lets one bot hand work to another bot in the fleet.
 *
 * This module is the `delegate_to_bot` pi extension: a replay-safe
 * `delegate_to_bot` tool backed by the target bot's Durable Object, plus the
 * durable background task that reports a slow answer back. Extracted from
 * `src/index.ts` so the guards (unknown target, self-delegation) are pure logic
 * testable without a live DO, mirroring `src/executor-mcp.ts`'s shape (header
 * doc, config type, exported factory).
 *
 * ## Why the call is replay-safe
 *
 * mackbot runs one Durable Object per bot, so a delegated task genuinely lives in
 * another DO's storage: a child conversation owned by this call's task is not
 * possible across that boundary. The properties of pi-durable's subagent
 * examples (21, 22) are applied at the DO boundary instead.
 *
 * The tool is `replay: "safe"` because the target's admission is idempotent on a
 * request id derived from the tool call's own durable task id
 * (`api.taskId`) and never from the model. An eviction during the wait means the
 * call is replayed after recovery, derives the same id, and joins the submission
 * it already made, so the work is not submitted twice. That is the only reason
 * `safe` is honest here; do not make the id depend on anything less durable.
 *
 * The first attempt pins what it admitted in a memo of the call's task before
 * anything reaches the target. A replay that finds the pin skips the guards and
 * rejoins: the roster may have changed since, and refusing then would orphan
 * work the target already holds. A replay whose first attempt already handed
 * the answer to the reporter returns the same receipt without waiting, so the
 * answer cannot arrive twice.
 *
 * `args.operationId` survives only as an explicit caller override, namespaced so
 * it cannot collide with the target's own `http:`/`cron:`/`delegate:` ids. The
 * model is never asked to supply one.
 *
 * ## Reporting instead of polling
 *
 * The default response long-polls the target (bounded at
 * {@link LONG_POLL_TIMEOUT_MS}). When the target has not settled by then, or when
 * the caller asked for `wait=false`, the tool starts a durable background
 * {@link DelegationReporter} owned by this conversation and returns a normal
 * result saying the answer will arrive as a new message. The reporter long-polls
 * the target across timeouts and, when it settles, submits the answer into this
 * conversation as a `followUp` input under a request id derived from the call,
 * so a restart cannot report twice. The model is never told to call the tool
 * again: a second call is a second tool task, and a fresh id would double-submit
 * real work to another bot.
 *
 * ## Front door semantics
 *
 * `target` is validated against the live roster the registry holds, so an
 * unknown or typo'd bot id comes back as a tool error instead of a Cloudflare
 * RPC failure. Self-delegation is rejected to avoid accidental runaway
 * recursion, and so is a chain of hand-offs that loops or runs long: each
 * delegated operation id carries the bots the work already passed through
 * (see `delegationChainOf`), so a target refuses to hand work back to any of
 * them, and refuses past {@link MAX_DELEGATION_DEPTH} hand-offs.
 *
 * ## Approvals
 *
 * Approval links the target bot surfaces may appear in its answer text; this
 * module relays them upstream when present. The target bot owns resuming the
 * paused approval (via its own `executor_resume`); the source only forwards the
 * link, because the bridge opens a fresh MCP connection per call and resumes
 * are keyed server-side — letting the source resume would leave the target's
 * conversation unaware of the outcome. The reporter applies the same relay to an
 * answer that arrives late.
 *
 * Public API (what `src/index.ts` imports):
 *
 *   import { createBotDelegation } from "./bot-delegation.ts";
 *   registry.install(createBotDelegation({ env, sourceBotId: botId, submissions, audit }));
 */

import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTask, defineTool } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Extension,
  SubmissionRecord,
  Task,
  TaskOptions,
  ToolExecutionApi,
  ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { BotConfig } from "@mackbot/contract";
import type { PiWhenBusy } from "agents/harness/pi";
import type { AuditSink } from "./audit-log.ts";
import {
  delegateCallerOperationId,
  delegateReportRequestId,
  delegateTaskOperationId,
  delegationChainOf,
} from "./operation.ts";
import { createDelegationPolicy } from "./services/delegation.ts";
import { REGISTRY_NAME } from "./services/bot-registry.ts";
import { LONG_POLL_TIMEOUT_MS } from "./constants.ts";
import { describeCause } from "./errors.ts";
import { toPrettyJson } from "./json.ts";
import { maybeApprovalNotice, redactSecrets } from "./executor-mcp.ts";
import type { Env, WaitResult } from "./index.ts";
import * as Effect from "effect/Effect";

export type BotDelegationConfig = {
  readonly env: Env;
  readonly sourceBotId: string;
  /**
   * The submissions of one conversation, from `harness.inspect()`. The run a
   * call belongs to is answering the conversation's placed inputs, and their
   * operation ids say which bots handed the work here. Without it every call
   * is treated as the first hand-off, so only self-delegation is refused.
   */
  readonly submissions?: (conversationId: ConversationId) => Promise<readonly SubmissionRecord[]>;
  /**
   * Where each step of a delegation is recorded, on the delegating bot's side:
   * requested or refused, delivered, re-attached after a replay, handed to the
   * reporter, settled or failed. Absent, nothing is audited.
   */
  readonly audit?: AuditSink;
};

/**
 * The longest chain of hand-offs one piece of work may take. A bot that was
 * handed work this many times may not hand it on: a chain past it is a
 * livelock in the making, not a plan.
 */
export const MAX_DELEGATION_DEPTH = 3;

/**
 * The bots that handed the running work here, oldest first: every bot named by
 * the operation ids of the inputs the run is answering, each once. A run that
 * answers a person or a schedule has an empty chain.
 */
export const runDelegationChain = (submissions: readonly SubmissionRecord[]): readonly string[] => {
  const chain: string[] = [];
  for (const submission of submissions) {
    if (submission.type !== "input" || submission.status !== "placed") continue;
    for (const bot of delegationChainOf(submission.requestId ?? "")) {
      if (!chain.includes(bot)) chain.push(bot);
    }
  }
  return chain;
};

/** What one delegation would be: who asks, whom, and how the work got here. */
export interface DelegationRequest {
  readonly roster: Readonly<Record<string, BotConfig>>;
  readonly source: string;
  readonly target: string;
  /** {@link runDelegationChain} of the run the call belongs to. */
  readonly chain: readonly string[];
}

/** Which guard refused a delegation. */
export type DelegationRefusalReason = "unknown-bot" | "self" | "loop" | "depth" | "allowlist";

/** A refused delegation: which guard refused it, and what the model is told. */
export interface DelegationRefusal {
  readonly reason: DelegationRefusalReason;
  readonly message: string;
}

/**
 * Why a delegation is refused, or `undefined` when it may go ahead. The target
 * must be declared, must not be the source or any bot the work already passed
 * through, the chain must stay within {@link MAX_DELEGATION_DEPTH}, and the
 * source's `delegatesTo` must allow it.
 */
export const refuseDelegation = (request: DelegationRequest): DelegationRefusal | undefined => {
  const { roster, source, target, chain } = request;
  if (!Object.hasOwn(roster, target)) {
    return {
      reason: "unknown-bot",
      message: `unknown bot "${target}". Declared bots: ${Object.keys(roster).join(", ")}`,
    };
  }
  if (target === source) return { reason: "self", message: "a bot cannot delegate to itself" };
  if (chain.includes(target)) {
    return {
      reason: "loop",
      message: `"${target}" already handed this work along (${[...chain, source].join(" -> ")}); delegating back to it would loop. Answer with what you have instead.`,
    };
  }
  if (chain.length + 1 > MAX_DELEGATION_DEPTH) {
    return {
      reason: "depth",
      message: `this work has already been delegated ${chain.length} times (${[...chain, source].join(" -> ")}); the limit is ${MAX_DELEGATION_DEPTH}. Answer with what you have instead.`,
    };
  }
  const policy = createDelegationPolicy(roster);
  if (!policy.canDelegate(source, target)) {
    const allowed = policy.allowedTargets(source);
    return {
      reason: "allowlist",
      message: `bot "${source}" is not allowed to delegate to "${target}" (not in delegatesTo: ${allowed.join(", ") || "(none)"})`,
    };
  }
  return undefined;
};

/** What the reporter needs to find the target's answer and deliver it. */
interface DelegationReportInput {
  readonly target: string;
  /** The target-side operation the delegation submitted under. */
  readonly operationId: string;
  /** Conversation-scoped request id of the report, derived from the delegating call. */
  readonly reportRequestId: string;
}

/**
 * The reporter saves a checkpoint at every step: how many long-polls it has
 * spent waiting, then the answer it is about to deliver.
 */
type DelegationReportCheckpoint =
  | { readonly phase: "watch"; readonly polls: number }
  | { readonly phase: "report"; readonly answer: string };

const REPORTER_NAME = "mackbot.delegation-reporter";
/** The tool task memo that keeps a replay from starting a second reporter. */
const REPORTER_MEMO = "delegation.reporterTask";
/**
 * The tool task memo that pins what the first attempt of a call admitted: the
 * target and the operation it submitted under. A replay that finds it rejoins
 * that operation instead of deciding again.
 */
const ADMISSION_MEMO = "delegation.admission";

/** What a call admitted, as {@link ADMISSION_MEMO} keeps it. */
type DelegationAdmission = {
  readonly target: string;
  readonly operationId: string;
  readonly depth: number;
};
/**
 * How many long-polls one reporter spends before it gives up and reports that
 * the target never settled: roughly four hours at the 55s bound.
 */
const REPORTER_MAX_POLLS = 240;

/**
 * Wrap one promise-based pi/DO call at the Effect boundary. This module is the
 * bridge between the Effect tool body and the promise-shaped Agents SDK.
 */
const attempt = <A>(call: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: call,
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

/** The text a settled wait carries, or its receipt as JSON. */
const textOf = (result: WaitResult): string => result.text ?? toPrettyJson(result);

/** An answer with the approval link the target surfaced, when it surfaced one. */
const withApprovalNotice = (text: string): string => {
  const notice = maybeApprovalNotice(text);
  return notice === null ? text : `${notice}\n\n${text}`;
};

/**
 * What the reporter delivers once the target stops working.
 *
 * A target that ended without an answer is reported too: the caller asked for
 * work and deserves the failure, not silence.
 */
const reportOf = (target: string, result: WaitResult): string =>
  result.status === "unanswered"
    ? `[delegation to "${target}" did not answer: ${result.reason ?? "unanswered"}]`
    : withApprovalNotice(textOf(result));

/** Where the reporter is created: owned by the calling conversation, and background. */
const reporterOptions: Omit<TaskOptions, "conversationId"> = {
  ownership: { kind: "conversation" },
  background: true,
};

/** One bounded long-poll of the target bot. */
const awaitTarget = (
  env: Env,
  target: string,
  operationId: string,
): Effect.Effect<WaitResult, Error> =>
  attempt(() => env.Bot.getByName(target).wait(operationId, LONG_POLL_TIMEOUT_MS));

/**
 * The background task that reports a slow delegation.
 *
 * It is background, so this conversation's Esc and idle waits leave it alone,
 * and conversation-owned, so `runtime.conversationId` is the conversation the
 * answer belongs in. Every phase commits a checkpoint, so a Durable Object
 * eviction mid-wait resumes at the last one instead of starting over silently.
 *
 * Two things make a restart harmless: the target's admission is idempotent on
 * the delegation's request id, and the report is a submission under a request id
 * derived from the delegating call.
 */
const createReporter = (
  env: Env,
  audit: AuditSink,
): Task<DelegationReportInput, DelegationReportCheckpoint, null, object> =>
  defineTask<DelegationReportInput, DelegationReportCheckpoint, null>({
    name: REPORTER_NAME,
    version: 1,
    initial: () => ({ phase: "watch", polls: 0 }),
    phases: {
      // One long-poll per invocation: a timeout commits the poll count and lets
      // the scheduler hand the reporter a fresh invocation, so no single
      // invocation holds a Durable Object open for the whole wait.
      watch: async (task, runtime, context) => {
        const polls = task.state.checkpoint.polls;
        const result = await Effect.runPromise(
          awaitTarget(env, task.input.target, task.input.operationId),
        );
        if (result.status === "timeout" && polls + 1 < REPORTER_MAX_POLLS) {
          await runtime.commit(
            () => ({ status: "running", checkpoint: { phase: "watch", polls: polls + 1 } }),
            context,
          );
          return;
        }
        // A rerun of this phase records the settlement again, and the audit
        // log keeps one per operation.
        audit({
          kind: "delegation.settled",
          operationId: task.input.operationId,
          detail: {
            target: task.input.target,
            status: result.status,
            reason: result.reason ?? null,
            via: "reporter",
          },
        });
        const answer =
          result.status === "timeout"
            ? `[delegation to "${task.input.target}" never settled (operationId ${task.input.operationId})]`
            : reportOf(task.input.target, result);
        await runtime.commit(
          () => ({ status: "running", checkpoint: { phase: "report", answer } }),
          context,
        );
      },
      // The answer arrives as a new message in this conversation. The request id
      // is derived from the delegating call, so a rerun of this phase — or a
      // second reporter for the same call — joins the first submission instead
      // of posting the answer twice.
      report: async (task, runtime, context) => {
        const conversation = await runtime.conversation(runtime.conversationId, context);
        if (conversation !== undefined) {
          await conversation.submit(
            {
              type: "input",
              content: task.state.checkpoint.answer,
              whenBusy: "followUp",
              requestId: task.input.reportRequestId,
            },
            context,
          );
        }
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
          context,
        );
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });

/** The arguments the model passes `delegate_to_bot`. */
interface DelegateArgs {
  readonly target: string;
  readonly task: string;
  readonly operationId?: string;
  readonly whenBusy?: PiWhenBusy;
  readonly wait?: boolean;
}

/** What admitting a call decided: the admission it pinned, or the guard that refused it. */
type AdmissionDecision =
  | { readonly kind: "admitted"; readonly admission: DelegationAdmission }
  | { readonly kind: "refused"; readonly refusal: DelegationRefusal };

/** How a failure's words are kept in the audit trail: without secrets, and bounded. */
const MAX_AUDIT_ERROR_CHARS = 500;

export function createBotDelegation(config: BotDelegationConfig): Extension {
  const { env, sourceBotId } = config;
  const audit: AuditSink = config.audit ?? (() => undefined);
  const reporterTask = createReporter(env, audit);

  /**
   * Start the reporter for this call, or reuse the one a replay already started.
   *
   * `api.createTask` commits with the call, so the reporter exists before the
   * tool's result is committed. The memo covers the window where a replay ran
   * `createTask` again; two reporters would still report once, because the
   * report's request id comes from the call.
   */
  const startReporter = (
    api: ToolExecutionApi,
    context: Context,
    input: DelegationReportInput,
  ): Effect.Effect<string, Error> =>
    Effect.gen(function* () {
      const existing = yield* attempt(() => api.memo<string>(REPORTER_MEMO, context));
      if (existing !== undefined) return existing;
      const created = yield* attempt(() =>
        api.createTask(reporterTask, input, reporterOptions, context),
      );
      yield* attempt(() => api.memo(REPORTER_MEMO, String(created), context));
      return String(created);
    });

  /**
   * Decide a call's first attempt: run the guards, and pin what they admitted
   * before anything reaches the target.
   *
   * The pin is what makes a replay rejoin rather than decide again. The roster
   * a replay would read may have changed since, and a guard that now refuses
   * would leave the target holding work this call no longer answers for.
   */
  const admit = Effect.fnUntraced(function* (
    args: DelegateArgs,
    api: ToolExecutionApi,
    context: Context,
  ): Effect.fn.Return<AdmissionDecision, Error> {
    // The roster is read on every call, because a human may have changed it
    // since the last one.
    const bots = yield* attempt(() => env.Registry.getByName(REGISTRY_NAME).roster());
    const submissions = config.submissions;
    const chain =
      submissions === undefined
        ? []
        : runDelegationChain(yield* attempt(() => submissions(api.conversationId)));
    // The call's task names the operation, so a replay of this call joins the
    // submission it already made. The chain rides in the id, so the target
    // refuses to hand the work back.
    const operationId =
      args.operationId === undefined
        ? delegateTaskOperationId(sourceBotId, String(api.taskId), chain)
        : delegateCallerOperationId(sourceBotId, args.operationId, chain);
    const refusal = refuseDelegation({
      roster: bots,
      source: sourceBotId,
      target: args.target,
      chain,
    });
    if (refusal !== undefined) {
      audit({
        kind: "delegation.refused",
        operationId,
        detail: { target: args.target, reason: refusal.reason, chain: [...chain, sourceBotId] },
      });
      return { kind: "refused", refusal };
    }
    // The durable winner, so two attempts racing to pin agree on one.
    const admission = yield* attempt(() =>
      api.memo<DelegationAdmission>(
        ADMISSION_MEMO,
        { target: args.target, operationId, depth: chain.length + 1 },
        context,
      ),
    );
    audit({
      kind: "delegation.requested",
      operationId: admission.operationId,
      detail: {
        target: admission.target,
        chain: [...chain, sourceBotId],
        depth: admission.depth,
        whenBusy: args.whenBusy ?? "followUp",
        wait: args.wait !== false,
        // A length, not the task: the audit trail is not a copy of the work.
        taskLength: args.task.length,
      },
    });
    return { kind: "admitted", admission };
  });

  /** A failure as the audit trail keeps it: no Executor secret, no URL, bounded. */
  const failed = (operationId: string, target: string, cause: unknown): ToolExecutionResult => {
    const error = redactSecrets(describeCause(cause), {
      url: env.EXECUTOR_URL,
      token: env.EXECUTOR_TOKEN,
    }).slice(0, MAX_AUDIT_ERROR_CHARS);
    audit({ kind: "delegation.failed", operationId, detail: { target, error } });
    return {
      output: [
        {
          type: "text",
          text: `delegation to "${target}" failed: ${describeCause(cause)}. The target may already hold the work; do not resubmit it.`,
        },
      ],
      isError: true,
    };
  };

  /**
   * Submit an admitted delegation and wait for it, or rejoin it on a replay.
   *
   * A replay whose first attempt already handed the answer to a reporter
   * returns the same receipt and leaves the target alone: waiting again could
   * deliver the answer twice, once here and once from the reporter. Otherwise
   * the replay submits under the pinned id, which the target joins to the work
   * it already holds, and waits: a target that settled meanwhile answers at
   * once with the answer the first attempt would have returned.
   */
  const deliver = Effect.fnUntraced(function* (
    args: DelegateArgs,
    admission: DelegationAdmission,
    replayed: boolean,
    api: ToolExecutionApi,
    context: Context,
  ): Effect.fn.Return<ToolExecutionResult, Error> {
    const { target, operationId } = admission;
    // The answer outlives this call: a durable reporter delivers it as a new
    // message instead of asking the model to poll.
    const running = (): ToolExecutionResult => ({
      output: [
        {
          type: "text",
          text: [
            `Delegated to "${target}".`,
            "The task is running; its answer will arrive as a new message in",
            "this conversation. Do not resubmit it.",
          ].join(" "),
        },
      ],
    });
    if (replayed) {
      const reporter = yield* attempt(() => api.memo<string>(REPORTER_MEMO, context));
      audit({
        kind: "delegation.reattached",
        operationId,
        detail: { target, reporter: reporter ?? null },
      });
      if (reporter !== undefined) return running();
    }
    const stub = env.Bot.getByName(target);
    const receipt = yield* attempt(() =>
      stub.submit(args.task, operationId, args.whenBusy ?? "followUp"),
    );
    // `accepted: false` is the target joining work it already holds: the
    // evidence that a replay did not submit twice.
    audit({
      kind: "delegation.delivered",
      operationId,
      detail: { target, accepted: receipt.accepted },
    });
    const reportInput: DelegationReportInput = {
      target,
      operationId,
      reportRequestId: delegateReportRequestId(sourceBotId, String(api.taskId)),
    };
    const background = (why: "no-wait" | "timeout") =>
      Effect.gen(function* () {
        const reporter = yield* startReporter(api, context, reportInput);
        audit({
          kind: "delegation.backgrounded",
          operationId,
          detail: { target, why, reporter },
        });
        return running();
      });
    if (args.wait === false) return yield* background("no-wait");
    const result = yield* attempt(() => stub.wait(operationId, LONG_POLL_TIMEOUT_MS));
    if (result.status === "timeout") return yield* background("timeout");
    audit({
      kind: "delegation.settled",
      operationId,
      detail: { target, status: result.status, reason: result.reason ?? null, via: "call" },
    });
    return {
      output: [{ type: "text", text: reportOf(target, result) }],
      isError: result.status === "unanswered",
    };
  });

  return defineExtension({
    name: "bot-delegation",
    tasks: [reporterTask],
    tools: [
      defineTool({
        name: "delegate_to_bot",
        description:
          "Hand a task to another bot in the fleet and get its answer. Validates the target against the declared roster. A bot cannot delegate to itself, and must never hand work back to a bot that delegated to it (mutual delegation livelocks). Returns the answer when it arrives within the wait; otherwise the work keeps running and its answer arrives later as a new message in this conversation. Never resubmit a delegated task.",
        parameters: Type.Object({
          target: Type.String({ description: "Bot id to delegate to (from the fleet's roster)." }),
          task: Type.String({ description: "The message/instructions to send to the target bot." }),
          operationId: Type.Optional(
            Type.String({
              description:
                "Explicit request id for this delegation. Omit it; the call's own task supplies one.",
            }),
          ),
          whenBusy: Type.Optional(
            Type.Union([Type.Literal("followUp"), Type.Literal("steer")], {
              description: "How to place the task if the target is busy (default: followUp).",
            }),
          ),
          wait: Type.Optional(
            Type.Boolean({
              description:
                "Wait for the answer now (default: true). With false the answer arrives later as a new message.",
            }),
          ),
        }),
        // Safe to replay after a crash: the first attempt pins its operation id,
        // derived from this call's task, and a replay rejoins it.
        replay: "safe",
        execute: (args, api, callContext): Promise<ToolExecutionResult> =>
          Effect.runPromise(
            Effect.gen(function* () {
              const pinned = yield* attempt(() =>
                api.memo<DelegationAdmission>(ADMISSION_MEMO, callContext),
              );
              const decision: AdmissionDecision =
                pinned === undefined
                  ? yield* admit(args, api, callContext)
                  : { kind: "admitted", admission: pinned };
              if (decision.kind === "refused") {
                const refused: ToolExecutionResult = {
                  output: [{ type: "text", text: decision.refusal.message }],
                  isError: true,
                };
                return refused;
              }
              const { admission } = decision;
              return yield* deliver(args, admission, pinned !== undefined, api, callContext).pipe(
                Effect.catch((cause) =>
                  Effect.succeed(failed(admission.operationId, admission.target, cause)),
                ),
              );
            }).pipe(
              // Before anything was admitted there is no operation yet, so the
              // failure is filed under the id the call's task would have used.
              Effect.catch((cause) =>
                Effect.succeed(
                  failed(
                    delegateTaskOperationId(sourceBotId, String(api.taskId)),
                    args.target,
                    cause,
                  ),
                ),
              ),
            ),
          ),
      }),
    ],
  });
}
