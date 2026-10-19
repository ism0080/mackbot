/**
 * executor-policy — the harness-side enforcement of the Executor approval rule.
 *
 * The `executor-protocol` prompt section in `executor-mcp.ts` teaches the model
 * never to invent an approval, but a prompt is advice: the model can still call
 * `executor_resume` with a requestId nobody approved, and the effect then runs
 * with nobody's consent. This extension is the enforcement. A `ToolTask` hook
 * blocks every `executor_resume` whose requestId the host does not still hold
 * pending, so a paused call can only end by a human's decision.
 *
 * The policy owns no approval state of its own: the host supplies
 * `approvalState`, which answers `pending` for a requestId that may still be
 * resumed, `decided` for one whose decision is spent, and `unknown` for one the
 * store never saw. Everything but `pending` blocks, so a host that lost track of
 * an approval fails closed instead of authorizing an effect nobody approved.
 *
 * The second half is bookkeeping: a wrap times `executor_call` and
 * `executor_execute` and reports each call's duration to the host. The wrapper
 * keeps the tool's own result, lets its error through, and reports the timing
 * either way, because a call that failed is still a call the host paid for.
 */

import type { JsonValue } from "@earendil-works/pi-ai";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import type { Extension, ToolHookCall, ToolRegistration, Wrap } from "@earendil-works/pi-durable";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The tool that carries a human's answer back to Executor. */
const RESUME_TOOL = "executor_resume";

/** The Executor tools whose duration the host wants to see. */
const TIMED_TOOLS = ["executor_call", "executor_execute"] as const;

/** What the approval store knows about one paused call. */
export type ApprovalState = "pending" | "decided" | "unknown";

export type ExecutorPolicyOptions = {
  /** The state of the approval for one requestId. */
  readonly approvalState: (requestId: string) => ApprovalState;
  /** Called after every Executor call the policy wraps. */
  readonly onCall: (call: { readonly name: string; readonly durationMs: number }) => void;
};

/** The refusal that stops a call before it runs. */
type Refusal = { readonly block: string };

/**
 * The requestId of a resume, when it is one. The arguments are model-issued, so
 * the id is parsed rather than assumed: a resume without a usable requestId
 * names no approval and therefore cannot be allowed.
 */
const requestIdOf = (value: JsonValue | undefined): string | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Schema.String)(value));

/** How a requestId reads in a refusal, whatever shape the model sent. */
const requestIdText = (requestId: JsonValue | undefined): string =>
  requestId === undefined ? "(missing)" : JSON.stringify(requestId);

/**
 * The refusal itself. It names the requestId, so the model can tell which
 * approval it invented from the one it may still wait for.
 */
const refuse = (requestId: JsonValue | undefined): Refusal => ({
  block:
    `executor_resume refused: no pending approval exists for requestId ${requestIdText(requestId)}. ` +
    "Resume only a requestId a human is still deciding on, and never invent an approval.",
});

/**
 * The extension that enforces the approval rule and times the Executor calls.
 *
 * The host owns the approvals, so it owns the two seams: `approvalState` says
 * whether a requestId may still be resumed, and `onCall` receives what each
 * wrapped call cost.
 */
export const createExecutorPolicy = (options: ExecutorPolicyOptions): Extension => {
  /**
   * The hook that guards the approval rule. Every other tool passes untouched:
   * the policy governs what authorizes an effect, not what the effect does.
   */
  const beforeTool = (call: ToolHookCall): Refusal | undefined => {
    if (call.name !== RESUME_TOOL) return undefined;
    const requestId = requestIdOf(call.arguments.requestId);
    if (requestId === undefined) return refuse(call.arguments.requestId);
    if (options.approvalState(requestId) !== "pending") return refuse(requestId);
    return undefined;
  };

  /**
   * The wrapper that times one Executor tool. It is built as a `Wrap` literal
   * rather than through `wrapTool()`, which would need a placeholder tool to
   * name the target: the wrap applies to whichever tool won the name, so none
   * has to exist here.
   */
  const timed = (name: string): Wrap => ({
    tool: name,
    wrap: (tool: ToolRegistration): ToolRegistration => ({
      ...tool,
      execute: async (args, api, context) => {
        const start = Date.now();
        try {
          return await tool.execute(args, api, context);
        } finally {
          options.onCall({ name, durationMs: Date.now() - start });
        }
      },
    }),
  });

  return defineExtension({
    name: "executor-policy",
    hooks: [hook(ToolTask, { beforeTool })],
    wraps: TIMED_TOOLS.map((name) => timed(name)),
  });
};
