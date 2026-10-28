/**
 * contract — the vocabulary the Worker and the browser bundle share.
 *
 * One place defines what a `Frame` is, what a bot's status view looks like, and
 * how the new routes' query strings and bodies decode, so the server encodes and
 * the client decodes the same shapes rather than re-encoding them by hand. The
 * module is imported by the browser bundle, so it must stay free of
 * Workers-only APIs and of the Worker's own modules.
 *
 * Request decoding happens at exactly one boundary: the HTTP front door
 * decodes the `*Schema`s below. Frames are built from pi's own committed
 * conversation view — the whole active transcript, plus `pi.live`,
 * `pi.inbox` and `pi.usage` — so nothing downstream validates them again.
 */

import type { EntryRecord, JsonObject } from "@earendil-works/pi-durable";
import type { ImagesInputContent, Message } from "@earendil-works/pi-ai";
import * as SchemaGetter from "effect/SchemaGetter";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ThinkingLevel } from "./catalog.ts";
import { OPERATION_ORIGINS, originOf } from "./operation.ts";

export { OPERATION_ORIGINS, OPERATION_PREFIXES, originOf } from "./operation.ts";
export type { OperationOrigin } from "./operation.ts";

// ---------------------------------------------------------------------------
// Enumerations mirrored across the Worker and the browser
// ---------------------------------------------------------------------------

export const OperationOriginSchema = Schema.Literals(Object.values(OPERATION_ORIGINS));

const THINKING_LEVEL_VALUES = {
  none: "none",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
} as const satisfies Record<ThinkingLevel, ThinkingLevel>;

export const ThinkingLevelSchema = Schema.Literals(Object.values(THINKING_LEVEL_VALUES));

/**
 * The provider a model comes from. The same two ids the model view carries,
 * named once so the registry's declaration and the view's reference cannot
 * drift apart.
 */
export const ProviderIdSchema = Schema.Literals(["opencode-go", "cloudflare"]);

export const ModelRefSchema = Schema.Struct({
  provider: ProviderIdSchema,
  id: Schema.String,
});
export type ModelRef = typeof ModelRefSchema.Type;

const ENTRY_ROLES = ["user", "assistant", "tool", "system"] as const;
export type EntryRole = (typeof ENTRY_ROLES)[number];

/**
 * A string with something in it. The Worker's chat body and the transcript
 * and events queries all accept the same shape, so the filter lives with the
 * vocabulary they share.
 */
export const trimmedNonEmpty = Schema.String.check(
  Schema.makeFilter((input: string) => input.trim().length > 0),
);

// ---------------------------------------------------------------------------
// Bot configuration — the registry's vocabulary
// ---------------------------------------------------------------------------

/**
 * The model a bot declares: the model's id.
 *
 * One spelling for every provider. A Workers AI model is named by its own
 * `@cf/...` path and any other model by its catalog id, so the browser renders
 * and writes a model the same way whichever provider it names.
 */
export const ModelDeclSchema = trimmedNonEmpty;
export type ModelDecl = typeof ModelDeclSchema.Type;

/**
 * A bot's id. It is the Durable Object's name, the path segment the routes
 * carry it in, and the key its transcript is filed under, so it is a slug: a
 * lowercase word, a digit, and dashes between them.
 */
export const BotIdSchema = Schema.String.check(
  Schema.makeFilter((input: string) => /^[a-z0-9][a-z0-9-]{0,62}$/u.test(input)),
);
export type BotId = typeof BotIdSchema.Type;

/**
 * The run policy one bot runs under. Every field is optional: a bot that
 * declares none falls back to the harness's own defaults.
 */
export const BotRuntimeSchema = Schema.Struct({
  contextWindow: Schema.optional(Schema.Number),
  reserveTokens: Schema.optional(Schema.Number),
  maxRetries: Schema.optional(Schema.Number),
  parallelTools: Schema.optional(Schema.Boolean),
  restartLimit: Schema.optional(Schema.Number),
});
export type BotRuntime = typeof BotRuntimeSchema.Type;

/**
 * One bot's declaration: what it is, how it thinks, what it is told, and who
 * it may hand work to.
 *
 * This is the whole configuration of a bot, so the browser can edit it and the
 * Worker can apply it without a second shape that has to be kept in step.
 */
export const BotConfigSchema = Schema.Struct({
  model: ModelDeclSchema,
  systemPrompt: trimmedNonEmpty,
  thinkingLevel: Schema.optional(ThinkingLevelSchema),
  brief: Schema.optional(trimmedNonEmpty),
  delegatesTo: Schema.optional(Schema.Array(trimmedNonEmpty)),
  runtime: Schema.optional(BotRuntimeSchema),
  commitments: Schema.optional(Schema.Boolean),
});
export type BotConfig = typeof BotConfigSchema.Type;

/**
 * The roster: every bot the fleet runs, keyed by bot id.
 */
export const RosterSchema = Schema.Struct({
  bots: Schema.Record(Schema.String, BotConfigSchema),
});
export type Roster = typeof RosterSchema.Type;

/**
 * The models the Worker knows, and the thinking levels each one supports.
 *
 * The catalog lives in the Worker, so the browser reads it over the wire
 * rather than bundling a second copy that could fall behind it.
 */
export const ModelCatalogSchema = Schema.Struct({
  models: Schema.Record(Schema.String, Schema.Array(ThinkingLevelSchema)),
});
export type ModelCatalog = typeof ModelCatalogSchema.Type;

/** The body of a bot write: the whole configuration of one bot. */
export const BotWriteSchema = Schema.Struct({ bot: BotConfigSchema });
export type BotWrite = typeof BotWriteSchema.Type;

/** The body of a bot create: the id to give the new bot, and its configuration. */
export const BotCreateSchema = Schema.Struct({
  id: BotIdSchema,
  bot: BotConfigSchema,
});
export type BotCreate = typeof BotCreateSchema.Type;

/** What a write or a create answers: the bot as it is now stored. */
export const BotWriteResultSchema = Schema.Struct({
  id: Schema.String,
  bot: BotConfigSchema,
});
export type BotWriteResult = typeof BotWriteResultSchema.Type;

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

export const EntryViewSchema = Schema.Struct({
  id: Schema.Number,
  kind: Schema.String,
  role: Schema.Literals(ENTRY_ROLES),
  text: Schema.String,
  at: Schema.optional(Schema.Number),
  origin: Schema.optional(OperationOriginSchema),
  data: Schema.optional(Schema.Unknown),
  /** The tool a `role: "tool"` entry reports on, when pi names it. */
  toolName: Schema.optional(Schema.String),
  /** Whether that tool result was an error, so the UI can surface it. */
  toolFailed: Schema.optional(Schema.Boolean),
});
export type EntryView = typeof EntryViewSchema.Type;

/**
 * One item `pi.inbox` is holding for the next boundary: user input queued
 * behind the run, or a passive entry write. `mode` is pi's own word, so a
 * write queued for later is not mistaken for something a run will answer.
 */
export const InboxViewSchema = Schema.Struct({
  id: Schema.String,
  mode: Schema.Literals(["followUp", "steer", "write"]),
  text: Schema.optional(Schema.String),
});
export type InboxView = typeof InboxViewSchema.Type;

/**
 * @deprecated The inbox item's earlier name. Kept so the browser can move to
 * {@link InboxView} without a second wire shape.
 */
export const QueuedItemViewSchema = InboxViewSchema;
/** @deprecated Use {@link InboxView}. */
export type QueuedItemView = InboxView;

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
 *
 * `kind` is the harness's own word for the failure, not a guess. A parked task
 * and a failed session are different problems and want different responses.
 */
export const FailureViewSchema = Schema.Struct({
  at: Schema.Number,
  kind: Schema.Literals([
    "session_failed",
    "task_faulted",
    "task_parked",
    "migration_failed",
    "task_outdated",
    "task_error",
    "extension_error",
    "host_error",
    "listener_error",
  ]),
  name: Schema.String,
  detail: Schema.String,
  taskId: Schema.optional(Schema.String),
  taskKind: Schema.optional(Schema.String),
  extension: Schema.optional(Schema.String),
  /** The host callback that failed, when the failure was one. */
  callback: Schema.optional(Schema.String),
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
  status: Schema.Literals(["pending", "running", "waiting", "sleeping", "completing", "blocked"]),
  phase: Schema.optional(Schema.String),
  owner: Schema.optional(Schema.String),
  background: Schema.Boolean,
  /** Why a blocked task cannot run, when the harness says. */
  reason: Schema.optional(Schema.String),
});
export type TaskView = typeof TaskViewSchema.Type;

/**
 * A request to run a parked task again. `taskId` names the task the harness
 * parked, which it reports as blocked with the reason `restart_limit`.
 */
export const RetryRequestSchema = Schema.Struct({
  taskId: Schema.String,
});
export type RetryRequest = typeof RetryRequestSchema.Type;

/**
 * What a retry did. `retried` is false when the task was not parked, so a
 * retry that had nothing to do says so rather than claiming success.
 */
export const RetryResultSchema = Schema.Struct({
  bot: Schema.String,
  taskId: Schema.String,
  retried: Schema.Boolean,
});
export type RetryResult = typeof RetryResultSchema.Type;

/**
 * A request to compact a conversation by hand.
 *
 * `session` names the conversation; absent means the bot's root conversation.
 * `instructions` is optional guidance for the summary, and may not be blank:
 * a request that says nothing is a request with no instructions, not an empty
 * string.
 */
export const CompactRequestSchema = Schema.Struct({
  session: Schema.optional(Schema.String),
  instructions: Schema.optional(trimmedNonEmpty),
});
export type CompactRequest = typeof CompactRequestSchema.Type;

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
// Frames — one committed conversation value, projected for rendering
// ---------------------------------------------------------------------------

/**
 * A JSON-safe value, as the projected documents carry it. The projections
 * below decode pi's durable JSON into the views, so a `details` payload the
 * browser renders is whatever the tool published, never a re-encoding of it.
 */
export type JsonValue = Schema.Json;

/** The run a client can name: the operation that started it and its inputs. */
export const LiveRunViewSchema = Schema.Struct({
  /** The operation id of the input that started the run; `""` when pi has none. */
  operationId: Schema.String,
  /** The submission ids the run is answering, as strings. */
  inputs: Schema.Array(Schema.String),
});
export type LiveRunView = typeof LiveRunViewSchema.Type;

export const LiveRetryViewSchema = Schema.Struct({
  at: Schema.Number,
  error: Schema.String,
});
export type LiveRetryView = typeof LiveRetryViewSchema.Type;

/**
 * The in-flight generation. `text` and `thinking` are the text and thinking
 * blocks of pi's committed partial response, so a client renders the same
 * content the transcript will carry rather than a token stream it has to fold.
 */
export const LiveGenerationViewSchema = Schema.Struct({
  attempt: Schema.Number,
  text: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  retry: Schema.optional(LiveRetryViewSchema),
});
export type LiveGenerationView = typeof LiveGenerationViewSchema.Type;

export const LiveToolViewSchema = Schema.Struct({
  callId: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["pending", "running", "done"]),
  output: Schema.optional(Schema.String),
  details: Schema.optional(Schema.Json),
});
export type LiveToolView = typeof LiveToolViewSchema.Type;

export const LiveCompactionViewSchema = Schema.Struct({
  taskId: Schema.String,
  reason: Schema.String,
  blocking: Schema.Boolean,
});
export type LiveCompactionView = typeof LiveCompactionViewSchema.Type;

export const LiveCompactionFailureViewSchema = Schema.Struct({
  taskId: Schema.String,
  reason: Schema.String,
  error: Schema.String,
});
export type LiveCompactionFailureView = typeof LiveCompactionFailureViewSchema.Type;

/**
 * `pi.live` as the browser renders it: the run in flight, the partial
 * response, the current tool round, and the compaction work that is holding
 * or repairing the context.
 */
export const LiveViewSchema = Schema.Struct({
  run: Schema.optional(LiveRunViewSchema),
  generation: Schema.optional(LiveGenerationViewSchema),
  tools: Schema.Array(LiveToolViewSchema),
  compactions: Schema.Array(LiveCompactionViewSchema),
  compactionFailure: Schema.optional(LiveCompactionFailureViewSchema),
});
export type LiveView = typeof LiveViewSchema.Type;

// `generation` is the segment the frame belongs to. It rides on every frame
// because a new segment restarts the stream's seq at 0, so a client resumed on
// `Last-Event-ID` must be able to tell that the cursor changed basis.
const SnapshotFrameSchema = Schema.Struct({
  kind: Schema.Literals(["snapshot"]),
  generation: Schema.Number,
  at: Schema.Number,
  session: Schema.String,
  /** The whole active transcript at delivery time, oldest first. */
  entries: Schema.Array(EntryViewSchema),
  live: LiveViewSchema,
  inbox: Schema.Array(InboxViewSchema),
  usage: UsageViewSchema,
  /** The oldest entry of the window; 0 when the window is empty. */
  transcriptFrom: Schema.Number,
});

const AppendFrameSchema = Schema.Struct({
  kind: Schema.Literals(["append"]),
  at: Schema.Number,
  entries: Schema.Array(EntryViewSchema),
});

const LiveFrameSchema = Schema.Struct({
  kind: Schema.Literals(["live"]),
  at: Schema.Number,
  live: LiveViewSchema,
});

const InboxFrameSchema = Schema.Struct({
  kind: Schema.Literals(["inbox"]),
  at: Schema.Number,
  items: Schema.Array(InboxViewSchema),
});

const UsageFrameSchema = Schema.Struct({
  kind: Schema.Literals(["usage"]),
  at: Schema.Number,
  usage: UsageViewSchema,
});

const RunFrameSchema = Schema.Struct({
  kind: Schema.Literals(["run"]),
  phase: Schema.Literals(["start", "end"]),
  at: Schema.Number,
  operationId: Schema.String,
});

const TaskFailedFrameSchema = Schema.Struct({
  kind: Schema.Literals(["task_failed"]),
  taskId: Schema.String,
  task: Schema.String,
  message: Schema.String,
});

export const FrameSchema = Schema.Union([
  SnapshotFrameSchema,
  AppendFrameSchema,
  LiveFrameSchema,
  InboxFrameSchema,
  UsageFrameSchema,
  RunFrameSchema,
  TaskFailedFrameSchema,
]);

/**
 * What the feed writes to a stream. The union is the wire vocabulary the
 * browser decodes; {@link FrameSchema} is the runtime decoder of the same
 * shape, kept beside it so the two cannot be written against different fields.
 */
export type Frame =
  | {
      kind: "snapshot";
      generation: number;
      at: number;
      session: string;
      entries: readonly EntryView[];
      live: LiveView;
      inbox: readonly InboxView[];
      usage: UsageView;
      transcriptFrom: number;
    }
  | { kind: "append"; at: number; entries: readonly EntryView[] }
  | { kind: "live"; at: number; live: LiveView }
  | { kind: "inbox"; at: number; items: readonly InboxView[] }
  | { kind: "usage"; at: number; usage: UsageView }
  | { kind: "run"; phase: "start" | "end"; at: number; operationId: string }
  | { kind: "task_failed"; taskId: string; task: string; message: string };

// ---------------------------------------------------------------------------
// Request shapes — decoded at the front door
// ---------------------------------------------------------------------------

const nonNegativeInt = Schema.String.check(
  // `Number("")` is `0`, so an empty query cursor must be rejected before the
  // decode, or `?from=` would silently mean "replay from the start".
  Schema.makeFilter((input: string) => /^\d+$/u.test(input)),
)
  .pipe(
    Schema.decodeTo(Schema.Number, {
      decode: SchemaGetter.transform((input: string) => Number(input)),
      encode: SchemaGetter.transform((value: number) => String(value)),
    }),
  )
  .check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isFinite());

/**
 * The page size the transcript route asks for when the client names none.
 */
export const DEFAULT_LIMIT = 50;

/**
 * The page size ceiling. {@link TranscriptQuerySchema} reads this constant
 * rather than repeating the number, so the route and its query agree.
 */
export const MAX_LIMIT = 200;

export const TranscriptQuerySchema = Schema.Struct({
  thread: Schema.optional(trimmedNonEmpty),
  before: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0))),
  limit: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: MAX_LIMIT }),
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
// Paging
// ---------------------------------------------------------------------------

export interface PageQuery {
  readonly before?: number;
  readonly limit?: number;
}

/**
 * Clamp rather than reject, because the Durable Object's RPC surface is reachable
 * without the front door's Schema.
 */
export const clampLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isSafeInteger(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(limit, 1), MAX_LIMIT);
};

/**
 * One page of entries, and the exclusive bound of the next one.
 */
export interface EntrySlice<T> {
  readonly entries: readonly T[];
  readonly nextBefore?: number;
}

/**
 * The newest `limit` entries strictly older than `before`, oldest first.
 *
 * The oldest id of a page is the exclusive bound of the next one, so a page
 * never repeats or skips an entry. The rule works on any entry with a numeric
 * id, so the Worker pages its own records and the browser pages the wire
 * views with the same code.
 */
export const slicePage = <T extends { readonly id: number }>(
  entries: readonly T[],
  query: PageQuery,
): EntrySlice<T> => {
  const before = query.before ?? Number.POSITIVE_INFINITY;
  const window = [...entries]
    .sort((left, right) => Number(left.id) - Number(right.id))
    .filter((entry) => Number(entry.id) < before);
  const page = window.slice(Math.max(window.length - clampLimit(query.limit), 0));
  const oldest = page[0];
  return {
    entries: page,
    nextBefore: window.length > page.length && oldest !== undefined ? Number(oldest.id) : undefined,
  };
};

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/**
 * The run an entry belongs to, derived from pi's own submissions: a run spans
 * the input entry it answers from through the entry that answered it. Nothing
 * is stored to say so, because `SubmissionRecord.entry` and `.answer` already
 * do, and they survive exactly as long as the run does.
 */
export interface RunProjection {
  /** The operation that admitted the run; `""` when the submission named none. */
  readonly operationId: string;
  /** The entry the run's input was placed as. */
  readonly startEntry: number;
  /** The entry that answered the run; absent while it is still live. */
  readonly answer?: number;
}

const contains = (run: RunProjection, entryId: number): boolean =>
  entryId >= run.startEntry && (run.answer === undefined || entryId <= run.answer);

/**
 * The newest run projection whose window contains `entryId`.
 *
 * Windows can overlap only while an earlier run is still open, and the newest
 * is the right owner there: pi admits one submission per placement, so the
 * later input's window starts after the earlier one's.
 */
export const runOfEntry = (
  entryId: number,
  runs: readonly RunProjection[],
): RunProjection | undefined => {
  let chosen: RunProjection | undefined;
  for (const run of runs) {
    if (!contains(run, entryId)) continue;
    if (chosen === undefined || run.startEntry >= chosen.startEntry) chosen = run;
  }
  return chosen;
};

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
 * The tool facts a result entry carries for the view. The response body is
 * model context and stays in `text`; the name and the failure bit are what a
 * human-facing summary can be built from without parsing that body.
 */
const toolOfEntry = (record: EntryRecord) => {
  const first = record.model?.[0];
  if (first?.role !== "toolResult") return {};
  return { toolName: first.toolName, toolFailed: first.isError };
};

/**
 * One transcript entry. `origin` is joined from the run the entry falls in,
 * because pi's `EntryRecord` carries no origin of its own. `at` is not: an
 * entry pi committed has no commit timestamp, so only the delivery of the
 * commit that carried it can date it, and that is the feed's to add.
 */
export const projectEntry = (record: EntryRecord, run?: RunProjection): EntryView => ({
  id: Number(record.id),
  kind: record.kind,
  role: roleOfEntry(record),
  text: (record.model ?? []).map(textOfMessage).join("\n"),
  origin: run === undefined || run.operationId === "" ? undefined : originOf(run.operationId),
  data: record.data,
  ...toolOfEntry(record),
});

const usageViewOf = (inputTokens: number, outputTokens: number, exchanges: number): UsageView => ({
  inputTokens,
  outputTokens,
  exchanges,
});

// Only the counters a view shows: `pi.usage` buckets carry cost and cache
// counters too, and a decode that required them would drop a bucket pi wrote
// without one.
const UsageBucketSchema = Schema.Struct({ input: Schema.Number, output: Schema.Number });
const UsageDocSchema = Schema.Struct({
  models: Schema.optional(Schema.Record(Schema.String, UsageBucketSchema)),
});
type UsageDoc = typeof UsageDocSchema.Type;
const EMPTY_USAGE: UsageDoc = {};

/**
 * Sum a conversation's ledger. The ledger is pi's durable `pi.usage` document,
 * decoded here rather than trusted, so a stale or partial document reads as
 * the spend it actually records. See {@link UsageView}.
 */
export const usageView = (state: JsonObject | undefined): UsageView => {
  const decoded = Option.getOrElse(
    Schema.decodeUnknownOption(UsageDocSchema)(state),
    () => EMPTY_USAGE,
  );
  const models = Object.values(decoded.models ?? {});
  let inputTokens = 0;
  let outputTokens = 0;
  for (const model of models) {
    inputTokens += model.input;
    outputTokens += model.output;
  }
  return usageViewOf(inputTokens, outputTokens, models.length);
};

const TextBlockSchema = Schema.Struct({
  type: Schema.Literals(["text"]),
  text: Schema.String,
});

const ThinkingBlockSchema = Schema.Struct({
  type: Schema.Literals(["thinking"]),
  thinking: Schema.String,
});

/**
 * The text and thinking blocks of a committed partial response. A provider
 * emits both as content blocks; a view shows them as the two streams a reader
 * follows, so a client never has to reassemble deltas.
 */
const GenerationMessageSchema = Schema.Struct({ content: Schema.Array(Schema.Unknown) });

const streamOfMessage = (
  message: typeof GenerationMessageSchema.Type | undefined,
): Pick<LiveGenerationView, "text" | "thinking"> => {
  if (message === undefined) return {};
  let text = "";
  let thinking = "";
  for (const block of message.content) {
    const asText = Schema.decodeUnknownOption(TextBlockSchema)(block);
    if (Option.isSome(asText)) text += asText.value.text;
    const asThinking = Schema.decodeUnknownOption(ThinkingBlockSchema)(block);
    if (Option.isSome(asThinking)) thinking += asThinking.value.thinking;
  }
  return { text: text === "" ? undefined : text, thinking: thinking === "" ? undefined : thinking };
};

const InboxContentSchema = Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]);

const InboxItemSchema = Schema.Struct({
  id: Schema.Number,
  mode: Schema.String,
  content: Schema.optional(InboxContentSchema),
});
const InboxDocSchema = Schema.Struct({ items: Schema.Array(InboxItemSchema) });
type InboxDoc = typeof InboxDocSchema.Type;
const EMPTY_INBOX: InboxDoc = { items: [] };

const textOfInboxContent = (
  content: typeof InboxContentSchema.Type | undefined,
): string | undefined => {
  if (content === undefined) return undefined;
  if (Schema.is(Schema.String)(content)) return content;
  const text = content
    .flatMap((block) => Option.toArray(Schema.decodeUnknownOption(TextBlockSchema)(block)))
    .map((block) => block.text)
    .join("");
  return text === "" ? undefined : text;
};

/**
 * `pi.inbox` as the browser renders it: what is queued for the next boundary.
 * A write is queued too, and is named as one, so a client does not offer to
 * answer it.
 */
export const inboxView = (state: JsonObject | undefined): readonly InboxView[] => {
  const decoded = Option.getOrElse(
    Schema.decodeUnknownOption(InboxDocSchema)(state),
    () => EMPTY_INBOX,
  );
  return decoded.items.flatMap((item) =>
    item.mode === "followUp" || item.mode === "steer" || item.mode === "write"
      ? [{ id: String(item.id), mode: item.mode, text: textOfInboxContent(item.content) }]
      : [],
  );
};

const LiveDocSchema = Schema.Struct({
  run: Schema.optional(Schema.Struct({ inputs: Schema.Array(Schema.Number) })),
  generation: Schema.optional(
    Schema.Struct({
      attempt: Schema.Number,
      message: Schema.optional(GenerationMessageSchema),
      retry: Schema.optional(LiveRetryViewSchema),
    }),
  ),
  tools: Schema.optional(
    Schema.Array(
      Schema.Struct({
        callId: Schema.String,
        name: Schema.String,
        status: Schema.Literals(["pending", "running", "done"]),
        output: Schema.optional(Schema.String),
        details: Schema.optional(Schema.Json),
      }),
    ),
  ),
  compactions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        taskId: Schema.Number,
        reason: Schema.String,
        blocking: Schema.Boolean,
      }),
    ),
  ),
  compactionFailure: Schema.optional(
    Schema.Struct({
      taskId: Schema.Number,
      reason: Schema.String,
      error: Schema.String,
    }),
  ),
});
type LiveDoc = typeof LiveDocSchema.Type;
const EMPTY_LIVE: LiveDoc = {};

const generationOf = (generation: LiveDoc["generation"]): LiveGenerationView | undefined => {
  if (generation === undefined) return undefined;
  return {
    attempt: generation.attempt,
    ...streamOfMessage(generation.message),
    retry: generation.retry,
  };
};

/**
 * `pi.live` as the browser renders it. `operationOf` maps a submission id to
 * the operation that admitted it, so the run's identity is pi's own and not a
 * second record; `""` means pi reported no request id for it.
 */
export const liveView = (
  state: JsonObject | undefined,
  operationOf: (input: string) => string,
): LiveView => {
  const decoded = Option.getOrElse(
    Schema.decodeUnknownOption(LiveDocSchema)(state),
    () => EMPTY_LIVE,
  );
  const inputs = (decoded.run?.inputs ?? []).map(String);
  const first = inputs[0];
  return {
    run:
      decoded.run === undefined
        ? undefined
        : { operationId: first === undefined ? "" : operationOf(first), inputs },
    generation: generationOf(decoded.generation),
    tools: (decoded.tools ?? []).map((tool) => ({
      callId: tool.callId,
      name: tool.name,
      status: tool.status,
      output: tool.output,
      details: tool.details,
    })),
    compactions: (decoded.compactions ?? []).map((compaction) => ({
      taskId: String(compaction.taskId),
      reason: compaction.reason,
      blocking: compaction.blocking,
    })),
    compactionFailure:
      decoded.compactionFailure === undefined
        ? undefined
        : {
            taskId: String(decoded.compactionFailure.taskId),
            reason: decoded.compactionFailure.reason,
            error: decoded.compactionFailure.error,
          },
  };
};

// ---------------------------------------------------------------------------
// Streams — the name a feed segment is filed under
// ---------------------------------------------------------------------------

/**
 * The durable name of one session's feed segment. A session's segments share a
 * tag and differ only here, so `list({ tag, limit: 1 })` finds the newest, and
 * a client resuming on `Last-Event-ID` can tell a new segment from a chunk of
 * the one it was reading.
 */
export const streamIdFor = (sessionId: string, generation: number): string =>
  `feed:${sessionId}:${generation}`;

/** The stream a client attaches to for one generation of one session. */
export const streamView = (
  sessionId: string,
  generation: number,
  cursor: number,
  state: StreamStatusView["state"] = "streaming",
): StreamStatusView => ({
  stream: streamIdFor(sessionId, generation),
  generation,
  cursor,
  state,
});
