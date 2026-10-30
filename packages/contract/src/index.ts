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
 * decodes the `*Schema`s below. Frames are built by the Worker from pi's own
 * committed conversation view (see `apps/api/src/projections.ts`), so nothing
 * downstream validates them again.
 */

import * as SchemaGetter from "effect/SchemaGetter";
import * as Schema from "effect/Schema";

import type { ThinkingLevel } from "./catalog.ts";
import { OPERATION_ORIGINS } from "./operation.ts";

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
  id: BotIdSchema,
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
 * The harness's own reason for a task it parked instead of running again. The
 * Worker picks parked tasks out by it and the browser offers a retry by it, so
 * the one word is named once.
 */
export const PARKED_REASON = "restart_limit";

/**
 * A request to run a parked task again. `taskId` names the task the harness
 * parked, which it reports as blocked with the reason {@link PARKED_REASON}.
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

/**
 * What a compaction request answers: the task the summary is made in, which a
 * client follows through the feed and the status view.
 */
export const CompactResultSchema = Schema.Struct({
  bot: Schema.String,
  taskId: Schema.String,
});
export type CompactResult = typeof CompactResultSchema.Type;

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

/**
 * `/status`'s envelope: one view per bot that answered, plus the bots whose
 * status could not be read, each with a message safe to show.
 */
export const StatusResponseSchema = Schema.Struct({
  bots: Schema.Record(Schema.String, BotViewSchema),
  errors: Schema.Record(Schema.String, Schema.String),
});
export type StatusResponse = typeof StatusResponseSchema.Type;

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

/** What the feed writes to a stream, as the browser decodes it. */
export type Frame = typeof FrameSchema.Type;

// ---------------------------------------------------------------------------
// Route answers — the bodies the Worker's routes respond with
// ---------------------------------------------------------------------------

/**
 * Every refusal's body: `{ error }`, carrying a message safe to show. A route
 * that refuses a request — a bad body, an unknown bot, a rule the write broke,
 * an approval that was not pending, a registry that is down — answers this.
 */
export const ErrorBodySchema = Schema.Struct({ error: Schema.String });
export type ErrorBody = typeof ErrorBodySchema.Type;

/**
 * `POST /chat/:bot`'s receipt when the caller does not wait for the answer:
 * the operation the server recorded, and whether it admitted it.
 */
export const ChatAcceptedSchema = Schema.Struct({
  operationId: Schema.String,
  accepted: Schema.Boolean,
});
export type ChatAccepted = typeof ChatAcceptedSchema.Type;

/** A decided approval: what `POST /approvals/:bot/:approvalId` answers. */
export const DecisionAcceptedSchema = Schema.Struct({
  approvalId: Schema.String,
  bot: Schema.String,
  status: Schema.Literals(["allowed", "denied"]),
  decidedAt: Schema.Number,
});
export type DecisionAccepted = typeof DecisionAcceptedSchema.Type;

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
