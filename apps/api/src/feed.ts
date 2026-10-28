/**
 * feed — the Bot Durable Object's SSE surface and the bridge behind it.
 *
 * The cursor, resume, heartbeat and abort semantics are `Streams`/`sseResponse`;
 * this module owns the two things they cannot. The first is stream identity:
 * one stream per segment of a session's feed — split into further segments only
 * when the chunk ceiling rotates — named `feed:<sessionId>:<generation>` and
 * tagged `feed:<botId>:<sessionId>`, so `list({ tag, limit: 1 })` finds a
 * session's newest segment. The second is the generation boundary.
 * `sseResponse` writes the raw seq as the SSE `id:` and a new segment's stream
 * restarts at zero, so a client resuming on `Last-Event-ID` from generation n
 * would ask for `from = 413` against a stream a few chunks long and silently
 * skip its head. Every snapshot therefore carries its generation, sequence zero
 * of a segment is a snapshot, and a request whose `?gen=` disagrees with the
 * stream's generation is replayed from `from: 0` — a fresh snapshot the client
 * recognises in band.
 *
 * The bridge no longer folds harness events: pi already commits the whole
 * active transcript, `pi.live`, `pi.inbox` and `pi.usage` as one conversation
 * view, so one watch callback per commit is the entire input. The entries whose
 * ids the current segment has not delivered yet become one `append` frame, and
 * the three documents become `live`/`inbox`/`usage` frames only when they
 * changed. Run identity comes from `harness.inspect()`'s submissions, which say
 * which input entry a run answers from and which entry answered it.
 *
 * One idempotent watcher per session appends those frames. `StreamWriter.append`
 * is a synchronous durable write made inside this isolate, and batches are
 * serialized through a per-session promise chain, so a commit cannot be
 * reordered or coalesced by a listener that is not awaited.
 */

import type { ConversationView, EntryRecord, SubmissionRecord } from "@earendil-works/pi-durable";
import type { StreamJson, Streams, StreamWriter } from "agents/streams";
import { sseResponse } from "agents/streams";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EventsQuerySchema,
  inboxView,
  liveView,
  projectEntry,
  runOfEntry,
  streamIdFor,
  usageView,
} from "@mackbot/contract";
import type {
  EntryView,
  EventsQuery,
  Frame,
  InboxView,
  LiveView,
  RunProjection,
  UsageView,
} from "@mackbot/contract";

/** How long an idle tail may stay silent before it sends a comment frame. */
const HEARTBEAT_MS = 25_000;

/**
 * Chunks one stream may hold before the bridge settles it and continues in the
 * next generation. A memory bound, not a cursor: the client learns the new
 * generation from the snapshot at its sequence zero. High enough that a normal
 * run never crosses it in production.
 */
export const MAX_CHUNKS_PER_STREAM = 1_024;

/**
 * Segments retained per tag. `Streams` documents no retention policy, so the
 * bridge sweeps settled streams past the newest few on every rotation. The
 * current segment is never a candidate; only terminal ones are deleted.
 */
export const RETENTION_STREAMS = 4;

/** The tag every stream of one session carries. */
export const streamTagFor = (botId: string, sessionId: string): string =>
  `feed:${botId}:${sessionId}`;

/**
 * The slice of pi's conversation watch this module needs.
 *
 * Structurally narrowed rather than imported whole, so a test can drive the
 * bridge with a fake view stream: `WatchHandle<ConversationView>` satisfies it,
 * and nothing here names a Cloudflare-only type.
 */
export interface WatchStart {
  /** The committed view this watch acquired: the seed of a new segment. */
  readonly value: ConversationView;
  /** Install the sole asynchronous listener. Never invoked inline. */
  start(listener: (value: ConversationView) => Promise<void>): void;
}

export interface FeedDeps {
  readonly botId: string;
  readonly streams: Streams;
  /** pi's own conversation view for one session. */
  readonly watch: (session: string) => Promise<WatchStart>;
  /**
   * The session's unsettled and settled submissions, from
   * `harness.inspect()`. A run's identity — its operation id, its input entry
   * and its answer — is read from these rather than recorded beside them.
   */
  readonly submissions: (session: string) => Promise<readonly SubmissionRecord[]>;
  /** The pi session a `?thread=` names, or the root session when absent. */
  readonly sessionOf: (thread: string | undefined) => Promise<string | undefined>;
  /** Overrides {@link MAX_CHUNKS_PER_STREAM}; the generation test lowers it. */
  readonly maxChunksPerStream?: number;
}

export interface Feed {
  /** Watch one session. Idempotent: a second call is a no-op. */
  readonly attach: (session: string) => Promise<void>;
  /** Serve `GET /events/:bot`: resolve, attach, then hand off to `sseResponse`. */
  readonly serve: (request: Request) => Promise<Response>;
}

interface SessionWriter {
  readonly streamId: string;
  readonly generation: number;
  readonly writer: StreamWriter;
  chunks: number;
}

/**
 * What one segment has told its readers. `delivered` is the highest entry id
 * the segment carried, so the next commit's new entries are the diff; the other
 * fields are the last projected document, serialized, so an unchanged document
 * costs no frame.
 */
interface SessionState {
  delivered: number;
  live: string;
  inbox: string;
  usage: string;
  /** The run whose `run: start` frame the client has been sent. */
  operation?: string;
}

/** One committed view with everything this module derives from it. */
interface Projection {
  readonly view: ConversationView;
  readonly runs: readonly RunProjection[];
  readonly live: LiveView;
  readonly inbox: readonly InboxView[];
  readonly usage: UsageView;
  /** The operation of the newest submission that is still queued or placed. */
  readonly operation?: string;
}

const methodNotAllowed = (): Response =>
  Response.json({ error: "method not allowed" }, { status: 405 });

const streamRequired = (): Response =>
  Response.json({ error: "stream is required" }, { status: 400 });

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const runStreams = <A>(task: () => Promise<A>): Promise<A> =>
  Effect.runPromise(Effect.tryPromise(task));

/**
 * SAFETY: a Frame is JSON data by construction — the contract's projections
 * emit only strings, numbers, booleans and arrays of them — but its arrays are
 * `readonly` while `StreamJson`'s are mutable, so the two types differ only in
 * the compiler. The append serializes immediately, so no mutation can observe
 * the gap.
 */
const toChunk = (frame: Frame): StreamJson => frame as StreamJson;

/**
 * The generation encoded in `feed:<session>:<generation>`, when it parses.
 * Exported because the transcript route reports the newest segment a client
 * should attach to, and it reads that segment's generation back the same way.
 */
export const generationFromStreamId = (streamId: string): number | undefined => {
  const separator = streamId.lastIndexOf(":");
  if (separator < 0) return undefined;
  const generation = Number(streamId.slice(separator + 1));
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : undefined;
};

/**
 * The run window each input submission names: its input entry through its
 * answer, or through the tail while it is still live. A write submission is
 * not a run, and an unanswered input never ran, so both are skipped.
 *
 * Exported because the transcript route joins the same projections onto the
 * entries it pages: a run's identity is derived once, in one place.
 */
export const runProjections = (
  submissions: readonly SubmissionRecord[],
): readonly RunProjection[] => {
  const runs: RunProjection[] = [];
  for (const submission of submissions) {
    if (submission.type !== "input") continue;
    if (submission.status === "placed") {
      runs.push({
        operationId: submission.requestId ?? "",
        startEntry: Number(submission.entry),
      });
    } else if (submission.status === "done") {
      runs.push({
        operationId: submission.requestId ?? "",
        startEntry: Number(submission.entry),
        answer: Number(submission.answer),
      });
    }
  }
  return runs;
};

/**
 * The operation of the run in flight: the newest submission still queued or
 * placed. A submission admitted without a request id names no operation, and a
 * `run` frame naming nothing would be worse than none.
 */
const activeOperation = (submissions: readonly SubmissionRecord[]): string | undefined => {
  let chosen: SubmissionRecord | undefined;
  for (const submission of submissions) {
    if (submission.type !== "input") continue;
    if (submission.status !== "queued" && submission.status !== "placed") continue;
    if (chosen === undefined || Number(submission.id) > Number(chosen.id)) chosen = submission;
  }
  return chosen?.requestId;
};

/** The operation id of the submission a `pi.live` run is answering. */
const operationOfInput =
  (submissions: readonly SubmissionRecord[]) =>
  (input: string): string => {
    for (const submission of submissions) {
      if (String(submission.id) === input) return submission.requestId ?? "";
    }
    return "";
  };

/** One entry as the wire carries it: projected, and dated by its delivery. */
const entryView = (record: EntryRecord, runs: readonly RunProjection[], at: number): EntryView => ({
  ...projectEntry(record, runOfEntry(Number(record.id), runs)),
  at,
});

export const createFeed = (deps: FeedDeps): Feed => {
  const maxChunks = deps.maxChunksPerStream ?? MAX_CHUNKS_PER_STREAM;
  const attached = new Set<string>();
  const writers = new Map<string, SessionWriter>();
  const states = new Map<string, SessionState>();
  const queues = new Map<string, Promise<void>>();

  const stateOf = (session: string): SessionState => {
    const existing = states.get(session);
    if (existing !== undefined) return existing;
    const created: SessionState = { delivered: -1, live: "", inbox: "", usage: "" };
    states.set(session, created);
    return created;
  };

  const project = async (session: string, view: ConversationView): Promise<Projection> => {
    const submissions = await deps.submissions(session);
    return {
      view,
      runs: runProjections(submissions),
      live: liveView(view.docs["pi.live"], operationOfInput(submissions)),
      inbox: inboxView(view.docs["pi.inbox"]),
      usage: usageView(view.docs["pi.usage"]),
      operation: activeOperation(submissions),
    };
  };

  /**
   * Fill a segment's sequence zero from the current view. The value the watch
   * carries is the snapshot: its entries date from now, because now is the
   * delivery of the commit that produced them, and its documents are the three
   * projections the segment will report changes to.
   */
  const seed = (session: string, target: SessionWriter, projection: Projection): void => {
    const at = Date.now();
    const entries = projection.view.entries.map((entry) => entryView(entry, projection.runs, at));
    target.writer.append(
      toChunk({
        kind: "snapshot",
        generation: target.generation,
        at,
        session,
        entries,
        live: projection.live,
        inbox: projection.inbox,
        usage: projection.usage,
        transcriptFrom: entries[0]?.id ?? 0,
      }),
    );
    target.chunks += 1;

    const state = stateOf(session);
    state.delivered = entries[entries.length - 1]?.id ?? state.delivered;
    state.live = JSON.stringify(projection.live);
    state.inbox = JSON.stringify(projection.inbox);
    state.usage = JSON.stringify(projection.usage);
    state.operation = projection.operation;
  };

  const sweep = async (session: string): Promise<void> => {
    const tag = streamTagFor(deps.botId, session);
    const listed = await runStreams(() =>
      deps.streams.list({ tag, limit: RETENTION_STREAMS + 16 }),
    );
    for (const status of listed.slice(RETENTION_STREAMS)) {
      if (status.state === "streaming") continue;
      await Effect.runPromise(
        Effect.tryPromise(() => deps.streams.delete(status.streamId)).pipe(
          Effect.catch(() => Effect.void),
        ),
      );
    }
  };

  const openSegment = async (
    session: string,
    generation: number,
    projection: Projection,
  ): Promise<SessionWriter | undefined> => {
    const streamId = streamIdFor(session, generation);
    const status = await runStreams(() => deps.streams.status(streamId));
    if (status !== null && status.state !== "streaming") return undefined;
    const writer = await runStreams(() =>
      deps.streams.open(streamId, { tag: streamTagFor(deps.botId, session) }),
    );
    const target: SessionWriter = { streamId, generation, writer, chunks: status?.cursor ?? 0 };
    writers.set(session, target);
    if (target.chunks === 0) seed(session, target, projection);
    await sweep(session);
    return target;
  };

  /**
   * Settle a segment a previous isolate left streaming, so retention can sweep
   * it. Its readers see the stream end and reconnect, which is what they already
   * do at a run's end.
   */
  const settleStream = async (streamId: string): Promise<void> => {
    const writer = await runStreams(() => deps.streams.open(streamId));
    writer.close();
  };

  /**
   * Start this isolate's segment. A generation is a rotation counter, so the
   * next one is one past every segment this session already has: a fresh
   * segment always begins at sequence zero with a snapshot, which is the only
   * state the bridge can prove it knows after a restart.
   */
  const seedSegment = async (
    session: string,
    projection: Projection,
  ): Promise<SessionWriter | undefined> => {
    const tag = streamTagFor(deps.botId, session);
    const listed = await runStreams(() =>
      deps.streams.list({ tag, limit: RETENTION_STREAMS + 16 }),
    );
    let newest = 0;
    for (const status of listed) {
      const generation = generationFromStreamId(status.streamId);
      if (generation !== undefined && generation > newest) newest = generation;
      if (status.state === "streaming") await settleStream(status.streamId);
    }
    return await openSegment(session, newest + 1, projection);
  };

  const rotateTo = async (
    session: string,
    generation: number,
    projection: Projection,
  ): Promise<void> => {
    const current = writers.get(session);
    if (current !== undefined) {
      current.writer.close();
      writers.delete(session);
    }
    await openSegment(session, generation, projection);
  };

  const emit = async (session: string, projection: Projection, frame: Frame): Promise<void> => {
    const target = writers.get(session) ?? (await openSegment(session, 1, projection));
    if (target === undefined) return;
    target.writer.append(toChunk(frame));
    target.chunks += 1;
    if (target.chunks >= maxChunks) await rotateTo(session, target.generation + 1, projection);
  };

  /**
   * One commit: the run boundary it moved, the entries it appended, and the
   * documents it changed. The order is the order a reader folds them in — a run
   * starts before its input entry lands and ends after its answer does.
   */
  const deliver = async (session: string, projection: Projection): Promise<void> => {
    const at = Date.now();
    const state = stateOf(session);
    if (writers.get(session) === undefined) await openSegment(session, 1, projection);

    const operation = projection.operation;
    if (operation !== undefined && operation !== state.operation) {
      await emit(session, projection, { kind: "run", phase: "start", at, operationId: operation });
    } else if (operation === undefined && state.operation !== undefined) {
      await emit(session, projection, {
        kind: "run",
        phase: "end",
        at,
        operationId: state.operation,
      });
    }
    state.operation = operation;

    const appended = projection.view.entries.filter((entry) => Number(entry.id) > state.delivered);
    if (appended.length > 0) {
      state.delivered = Number(appended[appended.length - 1]?.id ?? state.delivered);
      await emit(session, projection, {
        kind: "append",
        at,
        entries: appended.map((entry) => entryView(entry, projection.runs, at)),
      });
    }

    const live = JSON.stringify(projection.live);
    if (live !== state.live) {
      state.live = live;
      await emit(session, projection, { kind: "live", at, live: projection.live });
    }

    const inbox = JSON.stringify(projection.inbox);
    if (inbox !== state.inbox) {
      state.inbox = inbox;
      await emit(session, projection, { kind: "inbox", at, items: projection.inbox });
    }

    const usage = JSON.stringify(projection.usage);
    if (usage !== state.usage) {
      state.usage = usage;
      await emit(session, projection, { kind: "usage", at, usage: projection.usage });
    }
  };

  const enqueue = (session: string, view: ConversationView): Promise<void> => {
    const previous = queues.get(session) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        await deliver(session, await project(session, view));
      })
      .catch((cause: unknown) => {
        console.error(`mackbot: feed append for "${session}" failed: ${describeCause(cause)}`);
      });
    queues.set(session, next);
    return next;
  };

  const subscribe = async (session: string): Promise<void> => {
    const watch = await deps.watch(session);
    const projection = await project(session, watch.value);
    await seedSegment(session, projection);
    watch.start(async (value) => await enqueue(session, value));
  };

  const attach = async (session: string): Promise<void> => {
    // The guard is taken synchronously, before the first await, so a concurrent
    // second attach in this isolate cannot register a second watcher.
    if (attached.has(session)) return;
    attached.add(session);
    await Effect.runPromise(
      Effect.tryPromise(() => subscribe(session)).pipe(
        Effect.catch((cause) => {
          attached.delete(session);
          console.error(`mackbot: feed attach for "${session}" failed: ${describeCause(cause)}`);
          return Effect.void;
        }),
      ),
    );
  };

  const sessionForRequest = async (
    url: URL,
    thread: string | undefined,
  ): Promise<string | undefined> => {
    if (url.searchParams.get("stream") !== null) return undefined;
    return await deps.sessionOf(thread);
  };

  const newestStreamFor = async (session: string): Promise<string | undefined> => {
    const listed = await runStreams(() =>
      deps.streams.list({ tag: streamTagFor(deps.botId, session), limit: 1 }),
    );
    return listed[0]?.streamId;
  };

  const serve = async (request: Request): Promise<Response> => {
    if (request.method !== "GET") return methodNotAllowed();
    const url = new URL(request.url);
    const query = await decodeEvents(url);
    const session = await sessionForRequest(url, query.thread);
    if (session !== undefined) await attach(session);
    const explicit = url.searchParams.get("stream");
    const streamId =
      explicit ?? (session === undefined ? undefined : await newestStreamFor(session));
    if (streamId === undefined || streamId === "") return streamRequired();
    const from = resumeFrom(streamId, query);
    return await runStreams(() =>
      sseResponse(deps.streams, streamId, { request, from, heartbeatMs: HEARTBEAT_MS }),
    );
  };

  return { attach, serve };
};

/**
 * The replay point. With no `?gen=`, the client's own `?from=`/`Last-Event-ID`
 * wins, unchanged. With a `?gen=` that does not name this stream's generation,
 * the recorded cursor is on a different basis and only `from: 0` is safe;
 * otherwise `?from=` passes through.
 */
const resumeFrom = (streamId: string, query: EventsQuery): number | undefined => {
  if (query.gen === undefined) return query.from;
  return query.gen === generationFromStreamId(streamId) ? query.from : 0;
};

const decodeEvents = async (url: URL): Promise<EventsQuery> =>
  await Effect.runPromise(
    Schema.decodeUnknownEffect(EventsQuerySchema)(Object.fromEntries(url.searchParams)).pipe(
      // The route stays lenient: an undecodable cursor falls back to the header
      // rather than failing a connection the SDK's own writer can still serve.
      Effect.orElseSucceed((): EventsQuery => ({})),
    ),
  );
