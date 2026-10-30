/**
 * projections - pi's committed conversation, as the views the browser renders.
 *
 * The feed, the transcript route and the status view build their answers from
 * pi's own records: the entries of the active transcript and the `pi.live`,
 * `pi.inbox` and `pi.usage` documents. The views are the contract's; the code
 * that reads pi's records into them is the Worker's alone, so it lives here
 * rather than in the package the browser bundles.
 *
 * The documents are decoded rather than trusted, so a stale or partial one
 * reads as what it actually records.
 */

import type { EntryRecord, JsonObject } from "@earendil-works/pi-durable";
import type { ImagesInputContent, Message } from "@earendil-works/pi-ai";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { LiveRetryViewSchema, originOf } from "@mackbot/contract";
import type {
  EntryRole,
  EntryView,
  InboxView,
  LiveGenerationView,
  LiveView,
  StreamStatusView,
  UsageView,
} from "@mackbot/contract";

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

const textOfMessage = (message: Message): string =>
  Match.value(message).pipe(
    Match.discriminatorsExhaustive("role")({
      system: (system) => textOfBlockContent(system.content),
      user: (user) => textOfBlockContent(user.content),
      toolResult: (result) => textOfBlockContent(result.content),
      assistant: (assistant) =>
        assistant.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
    }),
  );

const ENTRY_ROLE_OF_MESSAGE_ROLE: Readonly<Record<Message["role"], EntryRole>> = {
  user: "user",
  assistant: "assistant",
  toolResult: "tool",
  system: "system",
};

const roleOfEntry = (record: EntryRecord): EntryRole => {
  const first = record.model?.[0];
  return first === undefined ? "system" : ENTRY_ROLE_OF_MESSAGE_ROLE[first.role];
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
