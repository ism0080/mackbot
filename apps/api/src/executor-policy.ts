/**
 * executor-policy — the harness-side enforcement of the Executor approval rule.
 *
 * The `executor-protocol` prompt section in `executor-mcp.ts` teaches the model
 * never to invent an approval, but a prompt is advice: the model can still call
 * `executor_resume` with a requestId nobody approved, and the effect then runs
 * with nobody's consent. This extension is the enforcement. A `ToolTask` hook
 * blocks every `executor_resume` that no human decision vouches for, so a
 * paused call ends only the way a human said it should.
 *
 * The policy owns no approval state of its own: the host supplies
 * `approvalState`, which answers `approved` for a requestId a human said yes to,
 * `denied` for one a human said no to, `pending` for one a human has not
 * answered yet, and `unknown` for one the store never saw. Everything but a
 * decision blocks, so a host that lost track of an approval fails closed
 * instead of authorizing an effect nobody approved.
 *
 * A decision is not a blank cheque either. The resume has to carry exactly
 * what the human said: an approval is an `accept` with the human's own form
 * content and nothing else, a denial is a `decline` or `cancel`, and any field
 * the human never saw (a `persist` that would remember the approval, say) is
 * refused. One decision admits one resume: the first resume claims the
 * requestId through `claimResume`, and every later one is refused.
 *
 * The second half is bookkeeping: a wrap times `executor_call` and
 * `executor_execute` and reports each call's duration to the host. The wrapper
 * keeps the tool's own result, lets its error through, and reports the timing
 * either way, because a call that failed is still a call the host paid for.
 */

import type { Context } from "@earendil-works/chord";
import type { JsonValue } from "@earendil-works/pi-ai";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import type {
  Extension,
  HookApi,
  ToolHookCall,
  ToolRegistration,
  Wrap,
} from "@earendil-works/pi-durable";
import type { ApprovalDecision } from "@mackbot/contract";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/** The tool that carries a human's answer back to Executor. */
const RESUME_TOOL = "executor_resume";

/** The Executor tools whose duration the host wants to see. */
const TIMED_TOOLS = ["executor_call", "executor_execute"] as const;

/**
 * The memo a resume's own tool task keeps of the requestId it claimed. A hook
 * can run again for the same call before its intent is recorded, and that rerun
 * is the same resume rather than a second one.
 */
const CLAIM_MEMO = "executor-policy.claimed";

/**
 * What the approval store knows about one paused call.
 *
 * `approved` and `denied` are a human's decision. `pending` is a human who has
 * not answered yet, and `unknown` is a requestId the store never saw. Only a
 * decision may end a paused call.
 */
export type ApprovalState = "pending" | "approved" | "denied" | "unknown";

/** The form content a human submitted with a decision. */
export type ApprovalContent = NonNullable<ApprovalDecision["content"]>;

/**
 * The state of one paused call, with what the decision carried: the content
 * the human submitted, and whether a resume has already carried it out.
 */
export type ApprovalStatus = {
  readonly state: ApprovalState;
  readonly content?: ApprovalContent;
  readonly resumed?: boolean;
};

export type ExecutorPolicyOptions = {
  /**
   * The state of the approval for one requestId. A bare state is a decision
   * without form content that no resume has carried out yet.
   */
  readonly approvalState: (requestId: string) => ApprovalState | ApprovalStatus;
  /**
   * Claim the one resume a decision admits: `true` for the first claim of a
   * requestId, `false` for every later one. A host that supplies none gets a
   * claim that lasts as long as the extension.
   */
  readonly claimResume?: (requestId: string) => boolean;
  /** Called after every Executor call the policy wraps. */
  readonly onCall: (call: { readonly name: string; readonly durationMs: number }) => void;
};

/** The refusal that stops a call before it runs. */
type Refusal = { readonly block: string };

const ContentSchema = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Array(Schema.String)]),
);

/**
 * The response a resume may carry. Exactly `action` and an optional `content`:
 * anything else is a term the human never agreed to.
 */
const ResponseSchema = Schema.Struct({
  action: Schema.Literals(["accept", "decline", "cancel"]),
  content: Schema.optional(ContentSchema),
});

type Response = typeof ResponseSchema.Type;

const RESUME_KEYS: ReadonlySet<string> = new Set(["requestId", "response"]);
const RESPONSE_KEYS: ReadonlySet<string> = new Set(["action", "content"]);

/**
 * The requestId of a resume, when it is one. The arguments are model-issued, so
 * the id is parsed rather than assumed: a resume without a usable requestId
 * names no approval and therefore cannot be allowed.
 */
const requestIdOf = (value: JsonValue | undefined): string | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Schema.String)(value));

/** The keys of a JSON object, or `undefined` when the value is not one. */
const keysOf = (value: JsonValue | undefined): readonly string[] | undefined =>
  Object.prototype.toString.call(value) === "[object Object]" &&
  value !== undefined &&
  value !== null
    ? Object.keys(value)
    : undefined;

/** The response a resume carries, when it is a well-formed one with no extra terms. */
const responseOf = (value: JsonValue | undefined): Response | undefined => {
  const keys = keysOf(value);
  if (keys === undefined || keys.some((key) => !RESPONSE_KEYS.has(key))) return undefined;
  return Option.getOrUndefined(Schema.decodeUnknownOption(ResponseSchema)(value));
};

const sameValue = (
  left: ApprovalContent[string] | undefined,
  right: ApprovalContent[string] | undefined,
): boolean => {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => item === right[index])
    );
  }
  return left === right;
};

/**
 * Whether two form contents say the same thing. Key order does not matter; an
 * absent content and an empty one are the same answer.
 */
export const sameApprovalContent = (
  left: ApprovalContent | undefined,
  right: ApprovalContent | undefined,
): boolean => {
  const leftKeys = Object.keys(left ?? {});
  const rightKeys = Object.keys(right ?? {});
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(right ?? {}, key) && sameValue(left?.[key], right?.[key]))
  );
};

const statusOf = (answer: ApprovalState | ApprovalStatus): ApprovalStatus =>
  Predicate.isString(answer) ? { state: answer } : answer;

/** How a requestId reads in a refusal, whatever shape the model sent. */
const requestIdText = (requestId: JsonValue | undefined): string =>
  requestId === undefined ? "(missing)" : JSON.stringify(requestId);

/**
 * The refusal itself. It names the requestId, so the model can tell which
 * approval it invented from the one a human decided on.
 */
const refuse = (requestId: JsonValue | undefined, why: string): Refusal => ({
  block:
    `executor_resume refused for requestId ${requestIdText(requestId)}: ${why} ` +
    "Resume only a requestId a human has decided on, and carry that decision through.",
});

/**
 * Why a resume does not carry the human's decision, or `undefined` when it
 * does. An approval is an `accept` with the human's content and nothing the
 * human did not submit; a denial is a `decline` or `cancel` with no content.
 */
const mismatch = (status: ApprovalStatus, response: Response): string | undefined => {
  if (status.state === "denied") {
    if (response.action === "accept") return "a human refused it.";
    if (response.content !== undefined) return "a refusal carries no form content.";
    return undefined;
  }
  if (response.action !== "accept") return 'a human approved it, so the response is "accept".';
  if (!sameApprovalContent(status.content, response.content)) {
    return "the form content is not the content the human submitted.";
  }
  return undefined;
};

/**
 * The extension that enforces the approval rule and times the Executor calls.
 *
 * The host owns the approvals, so it owns the seams: `approvalState` says
 * whether and how a human has decided on a requestId, `claimResume` spends the
 * one resume a decision admits, and `onCall` receives what each wrapped call
 * cost.
 */
export const createExecutorPolicy = (options: ExecutorPolicyOptions): Extension => {
  // A host without a durable claim still gets one resume per decision for as
  // long as this extension lives.
  const claimedHere = new Set<string>();
  const claim =
    options.claimResume ??
    ((requestId: string): boolean => {
      if (claimedHere.has(requestId)) return false;
      claimedHere.add(requestId);
      return true;
    });

  /**
   * The hook that guards the approval rule. Every other tool passes untouched:
   * the policy governs what authorizes an effect, not what the effect does.
   *
   * A paused call ends only by a human's decision. A requestId nobody decided
   * on is refused, and so is one a human is still deciding on: resuming it
   * would run the effect before the answer. The resume must carry the decision
   * as the human gave it, and only once.
   */
  const beforeTool = async (
    call: ToolHookCall,
    api: HookApi,
    context: Context,
  ): Promise<Refusal | undefined> => {
    if (call.name !== RESUME_TOOL) return undefined;
    const requestId = requestIdOf(call.arguments.requestId);
    if (requestId === undefined) {
      return refuse(call.arguments.requestId, "no requestId names an approval.");
    }
    // A rerun of the resume that already claimed this requestId is that same
    // resume, so it passes the gate it passed before.
    const claimed = await api.memo<string>(CLAIM_MEMO, context);
    if (claimed === requestId) return undefined;
    const status = statusOf(options.approvalState(requestId));
    if (status.state === "pending") {
      return refuse(requestId, "a human has not decided on it yet.");
    }
    if (status.state === "unknown") {
      return refuse(requestId, "no human decision exists for it.");
    }
    if (status.resumed === true) {
      return refuse(requestId, "the decision was already carried out by an earlier resume.");
    }
    if (Object.keys(call.arguments).some((key) => !RESUME_KEYS.has(key))) {
      return refuse(requestId, "the resume carries arguments the human never saw.");
    }
    const response = responseOf(call.arguments.response);
    if (response === undefined) {
      return refuse(
        requestId,
        "the resume carries no well-formed response with the human's action.",
      );
    }
    const why = mismatch(status, response);
    if (why !== undefined) return refuse(requestId, why);
    if (!claim(requestId)) {
      return refuse(requestId, "the decision was already carried out by an earlier resume.");
    }
    await api.memo(CLAIM_MEMO, requestId, context);
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
