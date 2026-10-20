/**
 * web-contract — the vocabulary the Worker and the browser bundle share.
 *
 * One place defines what a `Frame` is, what a bot's status view looks like, and
 * how the new routes' query strings and bodies decode, so the server encodes and
 * the client decodes the same shapes rather than re-encoding them by hand. The
 * module is imported by the browser bundle, so it must stay free of
 * Workers-only APIs and of `src/feed.ts` / `src/approvals.ts`.
 *
 * Request decoding happens at exactly two boundaries: the HTTP front door
 * decodes the `*Schema`s below, and the event bridge builds Frames with
 * {@link encodeFrame}. Nothing downstream validates again.
 */

import type {
  AgentEvent,
  EntryRecord,
  MessageChange,
  SnapshotEvent,
  SubmissionRecord,
  UsageState,
} from "@earendil-works/pi-durable";
import type { ImagesInputContent, Message, Usage } from "@earendil-works/pi-ai";
import * as Schema from "effect/Schema";

import { trimmedNonEmpty } from "./chat-request.ts";
import type { OperationOrigin } from "./operation.ts";
import { originOf } from "./operation.ts";
import type { ThinkingLevel } from "./bots.ts";

// ---------------------------------------------------------------------------
// Enumerations mirrored across the Worker and the browser
// ---------------------------------------------------------------------------

const ORIGIN_VALUES = {
  http: "http",
  cron: "cron",
  delegate: "delegate",
} as const satisfies Record<OperationOrigin, OperationOrigin>;

export const OperationOriginSchema = Schema.Literals(Object.values(ORIGIN_VALUES));

const THINKING_LEVEL_VALUES = {
  none: "none",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
} as const satisfies Record<ThinkingLevel, ThinkingLevel>;

export const ThinkingLevelSchema = Schema.Literals(Object.values(THINKING_LEVEL_VALUES));

export const ModelRefSchema = Schema.Struct({
  provider: Schema.Literals(["opencode-go", "cloudflare"]),
  id: Schema.String,
});

const ENTRY_ROLES = ["user", "assistant", "tool", "system"] as const;
export type EntryRole = (typeof ENTRY_ROLES)[number];

// ---------------------------------------------------------------------------
// Views — the renderable projections of harness state
// ---------------------------------------------------------------------------

export const UsageViewSchema = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  /**
   * Model ledgers the harness has spent against. `pi.usage` is keyed by
   * provider/model and carries no per-response counter, so the number of
   * buckets is the closest exact figure the harness reports.
   */
  exchanges: Schema.Number,
});
export type UsageView = typeof UsageViewSchema.Type;

export const ToolOutputSchema = Schema.Struct({
  append: Schema.optional(Schema.String),
  set: Schema.optional(Schema.String),
  trimStart: Schema.optional(Schema.Number),
});
export type ToolOutput = typeof ToolOutputSchema.Type;

export const TailViewSchema = Schema.Struct({
  attempt: Schema.Number,
  text: Schema.String,
  thinking: Schema.optional(Schema.String),
  retryAt: Schema.optional(Schema.Number),
  deferredAt: Schema.optional(Schema.Number),
});
export type TailView = typeof TailViewSchema.Type;

export const RunStartViewSchema = Schema.Struct({
  ordinal: Schema.Number,
  inputs: Schema.Array(Schema.String),
});
export type RunStartView = typeof RunStartViewSchema.Type;

export const QueuedItemViewSchema = Schema.Struct({
  id: Schema.String,
  mode: Schema.Literals(["followUp", "steer"]),
  text: Schema.optional(Schema.String),
});
export type QueuedItemView = typeof QueuedItemViewSchema.Type;

export const EntryViewSchema = Schema.Struct({
  id: Schema.Number,
  kind: Schema.String,
  role: Schema.Literals(ENTRY_ROLES),
  text: Schema.String,
  at: Schema.optional(Schema.Number),
  origin: Schema.optional(OperationOriginSchema),
  data: Schema.optional(Schema.Unknown),
});
export type EntryView = typeof EntryViewSchema.Type;

export const ApprovalViewSchema = Schema.Struct({
  approvalId: Schema.String,
  bot: Schema.String,
  thread: Schema.optional(Schema.String),
  toolPath: Schema.String,
  summary: Schema.String,
  artifact: Schema.optional(Schema.Struct({ label: Schema.String, body: Schema.String })),
  status: Schema.Literals(["pending", "allowed", "denied", "expired"]),
  requestedAt: Schema.Number,
  decidedAt: Schema.optional(Schema.Number),
});
export type ApprovalView = typeof ApprovalViewSchema.Type;

export const StreamStatusViewSchema = Schema.Struct({
  stream: Schema.String,
  generation: Schema.Number,
  cursor: Schema.Number,
  state: Schema.Literals(["streaming", "completed", "errored"]),
});
export type StreamStatusView = typeof StreamStatusViewSchema.Type;

/**
 * One failure the bot's harness reported. `at` is when the harness reported
 * it, not when the underlying fault happened; `name` is the error's own class
 * name, so a reader can tell a `TypeError` from a `RangeError`.
 */
export const FailureViewSchema = Schema.Struct({
  at: Schema.Number,
  kind: Schema.Literals(["session_failed", "harness_failure"]),
  name: Schema.String,
  detail: Schema.String,
});
export type FailureView = typeof FailureViewSchema.Type;

/**
 * One live task of the bot's harness. `status` is the harness's own word for
 * it, and `phase` is the task's current step when it has one. `owner` is the
 * task that owns this one, absent for a task its conversation owns.
 */
export const TaskViewSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  session: Schema.String,
  status: Schema.Literals([
    "pending",
    "running",
    "waiting",
    "sleeping",
    "completing",
    "blocked",
  ]),
  phase: Schema.optional(Schema.String),
  owner: Schema.optional(Schema.String),
  background: Schema.Boolean,
  /** Why a blocked task cannot run, when the harness says. */
  reason: Schema.optional(Schema.String),
});
export type TaskView = typeof TaskViewSchema.Type;

/**
 * A request to stop a bot's current work. `session` names the conversation to
 * stop; absent means the bot's root conversation.
 */
export const AbortRequestSchema = Schema.Struct({
  session: Schema.optional(Schema.String),
});
export type AbortRequest = typeof AbortRequestSchema.Type;

/**
 * What a stop did. `aborted` is false when there was nothing running to stop,
 * which is the normal answer for an idle bot.
 */
export const AbortResultSchema = Schema.Struct({
  bot: Schema.String,
  session: Schema.String,
  aborted: Schema.Boolean,
});
export type AbortResult = typeof AbortResultSchema.Type;

export const SubmissionViewSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(["input", "write"]),
  status: Schema.Literals(["queued", "placed", "done", "unanswered"]),
  operationId: Schema.optional(Schema.String),
  entry: Schema.optional(Schema.Number),
  answer: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.String),
});
export type SubmissionView = typeof SubmissionViewSchema.Type;

export const PendingOperationViewSchema = Schema.Struct({
  operationId: Schema.String,
  origin: OperationOriginSchema,
  status: Schema.Literals(["queued", "running"]),
});
export type PendingOperationView = typeof PendingOperationViewSchema.Type;

/**
 * The in-flight run, as the per-bot status view reports it.
 *
 * The subscription filter needs to know *which* bots are mid-run before it
 * subscribes, so the run summary — not just its stream cursor — has to be on
 * `/status`. Folded out of Frames alone, the same fact is only knowable after
 * subscribing, which is circular.
 */
export const ActiveRunViewSchema = Schema.Struct({
  ordinal: Schema.Number,
  inputs: Schema.Array(Schema.String),
  startedAt: Schema.Number,
  /** The conversation the run belongs to, so a client can stop that one. */
  session: Schema.String,
  stream: StreamStatusViewSchema,
});
export type ActiveRunView = typeof ActiveRunViewSchema.Type;

/**
 * One bot's status. `approvals` and `activeRun` are the fields the client's
 * subscriptions are a function of: the home screen subscribes to SSE only for
 * bots that are busy or blocked on a human.
 */
export const BotViewSchema = Schema.Struct({
  id: Schema.String,
  model: ModelRefSchema,
  thinkingLevel: Schema.NullOr(ThinkingLevelSchema),
  busy: Schema.Boolean,
  pending: Schema.Array(PendingOperationViewSchema),
  usage: UsageViewSchema,
  approvals: Schema.Array(ApprovalViewSchema),
  activeStream: Schema.optional(StreamStatusViewSchema),
  activeRun: Schema.optional(ActiveRunViewSchema),
  /**
   * The failures the harness reported, newest first, and the work it still has
   * live. Both are optional so a client built against an older contract still
   * decodes a newer answer; the server always sends them.
   */
  failures: Schema.optional(Schema.Array(FailureViewSchema)),
  tasks: Schema.optional(Schema.Array(TaskViewSchema)),
});
export type BotView = typeof BotViewSchema.Type;

export const TranscriptPageSchema = Schema.Struct({
  session: Schema.String,
  entries: Schema.Array(EntryViewSchema),
  nextBefore: Schema.optional(Schema.Number),
  stream: StreamStatusViewSchema,
});
export type TranscriptPage = typeof TranscriptPageSchema.Type;

// ---------------------------------------------------------------------------
// Frames — one harness event, projected for rendering
// ---------------------------------------------------------------------------

// `generation` is the run ordinal the frame belongs to. It rides on every
// frame because a new run restarts the stream's seq at 0, so a client resumed
// on `Last-Event-ID` must be able to detect that the cursor changed basis.
const SnapshotFrameSchema = Schema.Struct({
  kind: Schema.Literals(["snapshot"]),
  generation: Schema.Number,
  at: Schema.Number,
  session: Schema.String,
  entries: Schema.Array(EntryViewSchema),
  tail: Schema.optional(TailViewSchema),
  inbox: Schema.Array(QueuedItemViewSchema),
  run: Schema.optional(RunStartViewSchema),
  usage: UsageViewSchema,
  transcriptFrom: Schema.Number,
});

const RunFrameSchema = Schema.Struct({
  kind: Schema.Literals(["run"]),
  phase: Schema.Literals(["start", "end"]),
  at: Schema.Number,
  inputs: Schema.Array(Schema.String),
});

const TurnFrameSchema = Schema.Struct({
  kind: Schema.Literals(["turn"]),
  phase: Schema.Literals(["start", "end"]),
});

const MessageFrameSchema = Schema.Struct({
  kind: Schema.Literals(["message"]),
  phase: Schema.Literals(["start", "end"]),
  at: Schema.Number,
  entry: Schema.optional(EntryViewSchema),
});

const DeltaFrameSchema = Schema.Struct({
  kind: Schema.Literals(["delta"]),
  contentIndex: Schema.Number,
  channel: Schema.Literals(["text", "thinking"]),
  delta: Schema.String,
  usage: UsageViewSchema,
});

const ToolFrameSchema = Schema.Struct({
  kind: Schema.Literals(["tool"]),
  phase: Schema.Literals(["start", "update", "end"]),
  toolCallId: Schema.String,
  toolName: Schema.String,
  args: Schema.optional(Schema.Unknown),
  output: Schema.optional(ToolOutputSchema),
  error: Schema.optional(Schema.String),
  parentToolCallId: Schema.optional(Schema.String),
});

const InboxFrameSchema = Schema.Struct({
  kind: Schema.Literals(["inbox"]),
  items: Schema.Array(QueuedItemViewSchema),
});

const SubmissionFrameSchema = Schema.Struct({
  kind: Schema.Literals(["submission"]),
  record: SubmissionViewSchema,
});

const UsageFrameSchema = Schema.Struct({
  kind: Schema.Literals(["usage"]),
  usage: UsageViewSchema,
});

const ApprovalFrameSchema = Schema.Struct({
  kind: Schema.Literals(["approval"]),
  approval: ApprovalViewSchema,
});

const ApprovalResolvedFrameSchema = Schema.Struct({
  kind: Schema.Literals(["approval_resolved"]),
  approvalId: Schema.String,
  decision: Schema.Literals(["allow", "deny", "expired"]),
});

const TaskFailedFrameSchema = Schema.Struct({
  kind: Schema.Literals(["task_failed"]),
  taskId: Schema.String,
  task: Schema.String,
  message: Schema.String,
});

export const FrameSchema = Schema.Union([
  SnapshotFrameSchema,
  RunFrameSchema,
  TurnFrameSchema,
  MessageFrameSchema,
  DeltaFrameSchema,
  ToolFrameSchema,
  InboxFrameSchema,
  SubmissionFrameSchema,
  UsageFrameSchema,
  ApprovalFrameSchema,
  ApprovalResolvedFrameSchema,
  TaskFailedFrameSchema,
]);
export type Frame = typeof FrameSchema.Type;

// ---------------------------------------------------------------------------
// Request shapes — decoded at the front door
// ---------------------------------------------------------------------------

const nonNegativeInt = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);

export const TranscriptQuerySchema = Schema.Struct({
  thread: Schema.optional(trimmedNonEmpty),
  before: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
  ),
  limit: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: 200 }),
    ),
  ),
});
export type TranscriptQuery = typeof TranscriptQuerySchema.Type;

export const ApprovalDecisionSchema = Schema.Struct({
  action: Schema.Literals(["allow", "deny"]),
  content: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Array(Schema.String)]),
    ),
  ),
});
export type ApprovalDecision = typeof ApprovalDecisionSchema.Type;

export const SessionRequestSchema = Schema.Struct({ code: Schema.NonEmptyString });
export type SessionRequest = typeof SessionRequestSchema.Type;

export const EventsQuerySchema = Schema.Struct({
  thread: Schema.optional(trimmedNonEmpty),
  gen: Schema.optional(nonNegativeInt),
  from: Schema.optional(nonNegativeInt),
});
export type EventsQuery = typeof EventsQuerySchema.Type;

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/** The run window an entry falls in, as `mackbot_runs` records it. */
export interface RunWindow {
  readonly ordinal: number;
  readonly operationId?: string;
  readonly startedAt: number;
  readonly settledAt?: number;
}

const textOfBlockContent = (content: string | readonly ImagesInputContent[]): string => {
  if (Schema.is(Schema.String)(content)) return content;
  return content.map((block) => (block.type === "text" ? block.text : "")).join("");
};

const textOfMessage = (message: Message): string => {
  switch (message.role) {
    case "system":
    case "user":
    case "toolResult":
      return textOfBlockContent(message.content);
    case "assistant":
      return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  }
};

const roleOfEntry = (record: EntryRecord): EntryRole => {
  const first = record.model?.[0];
  if (first === undefined) return "system";
  switch (first.role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "toolResult":
      return "tool";
    case "system":
      return "system";
  }
};

/**
 * One transcript entry. `at` and `origin` are joined from the run window the
 * entry falls in, because pi's `EntryRecord` has no timestamp and no origin.
 */
export const projectEntry = (record: EntryRecord, run?: RunWindow): EntryView => ({
  id: Number(record.id),
  kind: record.kind,
  role: roleOfEntry(record),
  text: (record.model ?? []).map(textOfMessage).join("\n"),
  at: run?.startedAt,
  origin: run?.operationId === undefined ? undefined : originOf(run.operationId),
  data: record.data,
});

const usageViewOf = (inputTokens: number, outputTokens: number, exchanges: number): UsageView => ({
  inputTokens,
  outputTokens,
  exchanges,
});

/** Sum a conversation's ledger. See {@link UsageView}. */
export const usageView = (state: UsageState): UsageView => {
  let inputTokens = 0;
  let outputTokens = 0;
  const models = Object.values(state.models);
  for (const model of models) {
    inputTokens += model.input;
    outputTokens += model.output;
  }
  return usageViewOf(inputTokens, outputTokens, models.length);
};

const usageViewOfUsage = (usage: Usage): UsageView => usageViewOf(usage.input, usage.output, 1);

const inboxView = (
  items: readonly { readonly id: number; readonly mode: string }[],
): readonly QueuedItemView[] =>
  items.flatMap((item) =>
    item.mode === "followUp" || item.mode === "steer"
      ? [{ id: String(item.id), mode: item.mode } satisfies QueuedItemView]
      : [],
  );

const tailView = (generation: SnapshotEvent["generation"]): TailView | undefined => {
  if (generation === undefined) return undefined;
  const message = generation.message;
  return {
    attempt: generation.attempt,
    text: message === undefined ? "" : textOfMessage(message),
    retryAt: generation.retry?.at,
    deferredAt: generation.deferred?.pollAt,
  };
};

const submissionView = (record: SubmissionRecord): SubmissionView => ({
  id: String(record.id),
  type: record.type,
  status: record.status,
  operationId: record.requestId,
  entry: record.entry === undefined ? undefined : Number(record.entry),
  answer: record.answer === undefined ? undefined : Number(record.answer),
  reason: record.reason,
});

const toolOutputView = (
  output: Extract<AgentEvent, { type: "tool_execution_update" }>["output"],
): ToolOutput | undefined => {
  if (output === undefined) return undefined;
  if ("set" in output) return { set: output.set };
  return { append: output.append, trimStart: output.trimStart };
};

const deltaOf = (
  changes: readonly MessageChange[],
): { contentIndex: number; channel: "text" | "thinking"; delta: string } | undefined => {
  for (const change of changes) {
    if (change.type === "text_delta") {
      return { contentIndex: change.contentIndex, channel: "text", delta: change.delta };
    }
    if (change.type === "thinking_delta") {
      return { contentIndex: change.contentIndex, channel: "thinking", delta: change.delta };
    }
  }
  return undefined;
};

const parentOf = (event: { readonly parentToolCallId?: string }) => ({
  parentToolCallId: event.parentToolCallId,
});

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------

/**
 * The session a snapshot belongs to. A snapshot carries no session id of its
 * own; its entries name the conversation, so a fresh transcript has no name
 * here — the bridge seeds through {@link encodeSnapshot}, which takes the
 * session explicitly.
 */
const sessionOf = (event: SnapshotEvent): string =>
  event.entries[0] === undefined ? "" : String(event.entries[0].conversationId);

export const encodeSnapshot = (
  event: SnapshotEvent,
  session: string,
  at: number,
  generation: number,
): Frame => {
  const tail = tailView(event.generation);
  const first = event.entries[0];
  return {
    kind: "snapshot",
    generation,
    at,
    session,
    entries: event.entries.map((entry) => projectEntry(entry)),
    tail,
    inbox: inboxView(event.inbox),
    run:
      event.run === undefined
        ? undefined
        : { ordinal: generation, inputs: event.run.inputs.map(String) },
    usage: usageView(event.usage),
    transcriptFrom: first === undefined ? 0 : Number(first.id),
  };
};

// The events with no rendered surface: retry/deferred bookkeeping and agent
// reconfiguration change the tail the next snapshot carries; the compaction
// task's own start/end are bookkeeping for the entry it eventually appends.
type UnrenderedEvent = Extract<
  AgentEvent,
  {
    type:
      | "auto_retry_start"
      | "auto_retry_end"
      | "deferred_poll"
      | "agent_changed"
      | "compaction_start"
      | "compaction_end";
  }
>;

type RenderableEvent = Exclude<AgentEvent, UnrenderedEvent>;

/** The `never` bindings below are the totality guarantee: a new `AgentEvent`
 * variant fails `tsc` at whichever arm cannot place it, rather than being
 * silently dropped. */
const encodeRenderable = (
  event: RenderableEvent,
  at: number,
  generation: number,
): Frame | undefined => {
  switch (event.type) {
    case "snapshot":
      return encodeSnapshot(event, sessionOf(event), at, generation);
    case "run_start":
      return { kind: "run", phase: "start", at, inputs: event.inputs.map(String) };
    case "run_end":
      return { kind: "run", phase: "end", at, inputs: event.inputs.map(String) };
    case "turn_start":
      return { kind: "turn", phase: "start" };
    case "turn_end":
      return { kind: "turn", phase: "end" };
    case "message_start":
      return { kind: "message", phase: "start", at };
    case "message_end":
    case "entry_appended":
      return { kind: "message", phase: "end", at, entry: projectEntry(event.entry) };
    case "message_update": {
      const delta = deltaOf(event.changes);
      return delta === undefined
        ? undefined
        : { kind: "delta", ...delta, usage: usageViewOfUsage(event.usage) };
    }
    case "tool_execution_start":
      return {
        kind: "tool",
        phase: "start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        ...parentOf(event),
      };
    case "tool_execution_update": {
      const output = toolOutputView(event.output);
      return {
        kind: "tool",
        phase: "update",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        output,
        ...parentOf(event),
      };
    }
    case "tool_execution_end":
      return {
        kind: "tool",
        phase: "end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...parentOf(event),
      };
    case "inbox_update":
      return { kind: "inbox", items: inboxView(event.items) };
    case "submission":
      return { kind: "submission", record: submissionView(event.record) };
    case "usage_changed":
      return { kind: "usage", usage: usageView(event.usage) };
    case "task_failed":
      return {
        kind: "task_failed",
        taskId: String(event.taskId),
        task: event.kind,
        message: event.message,
      };
    default: {
      const unhandled: never = event;
      return unhandled;
    }
  }
};

/**
 * Encode one harness event as a Frame, or `undefined` when it changes no
 * rendered surface.
 *
 * The unrendered variants are the switch's cases, so its default hands the
 * remainder to {@link encodeRenderable} — typed as the complement, which makes
 * a new variant fail `tsc` there. Each switch stays under the complexity
 * budget only because the union is split this way.
 */
export const encodeFrame = (
  event: AgentEvent,
  at: number,
  generation: number,
): Frame | undefined => {
  switch (event.type) {
    case "auto_retry_start":
    case "auto_retry_end":
    case "deferred_poll":
    case "agent_changed":
    case "compaction_start":
    case "compaction_end":
      return undefined;
    default:
      return encodeRenderable(event, at, generation);
  }
};
