/**
 * feed — the Bot Durable Object's SSE surface and the bridge behind it.
 *
 * The cursor, resume, heartbeat and abort semantics are `Streams`/`sseResponse`;
 * this module owns the two things they cannot. The first is stream identity:
 * one stream per run — split into further segments only when the chunk ceiling
 * rotates mid-run — named `feed:<sessionId>:<ordinal>` and tagged
 * `feed:<botId>:<sessionId>`, so `list({ tag, limit: 1 })` finds a session's
 * newest segment. The second is the generation boundary. `sseResponse` writes
 * the raw seq as the SSE `id:` and a new run's stream restarts at zero, so a
 * client resuming on `Last-Event-ID` from run n would ask for `from = 413`
 * against a stream a few chunks long and silently skip its head. Every Frame
 * therefore carries its generation, sequence zero is a snapshot, and a request
 * whose `?gen=` disagrees with the stream's generation is replayed from
 * `from: 0` — a fresh snapshot the client recognises in band.
 *
 * One idempotent watcher per session appends one encoded Frame per harness
 * event. `StreamWriter.append` is a synchronous durable write made inside this
 * isolate, and batches are serialized through a per-session promise chain, so a
 * commit cannot be reordered or coalesced by a listener that is not awaited.
 */

import type {
  AgentEvent,
  AgentEventStream,
  EntryRecord,
  SnapshotEvent,
} from "@earendil-works/pi-durable";
import type { StreamJson, Streams, StreamWriter } from "agents/streams";
import { sseResponse } from "agents/streams";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { streamIdFor } from "./runs.ts";
import type { RunRow, RunStore } from "./runs.ts";
import { EventsQuerySchema, encodeFrame, encodeSnapshot } from "@mackbot/contract";
import type { EventsQuery, Frame } from "@mackbot/contract";

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

export interface FeedDeps {
  readonly botId: string;
  readonly streams: Streams;
  readonly runs: RunStore;
  /** pi's agent events for one session: a snapshot, then one batch per commit. */
  readonly events: (session: string) => Promise<AgentEventStream>;
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

const methodNotAllowed = (): Response =>
  Response.json({ error: "method not allowed" }, { status: 405 });

const streamRequired = (): Response =>
  Response.json({ error: "stream is required" }, { status: 400 });

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const runStreams = <A>(task: () => Promise<A>): Promise<A> =>
  Effect.runPromise(Effect.tryPromise(task));

/**
 * SAFETY: a Frame is JSON data by construction — the contract's encoders
 * emit only strings, numbers, booleans and arrays of them — but its arrays are
 * `readonly` while `StreamJson`'s are mutable, so the two types differ only in
 * the compiler. The append serializes immediately, so no mutation can observe
 * the gap.
 */
const toChunk = (frame: Frame): StreamJson => frame as StreamJson;

/** The generation encoded in `feed:<session>:<generation>`, when it parses. */
const generationOf = (streamId: string): number | undefined => {
  const parts = streamId.split(":");
  if (parts.length !== 3 || parts[0] !== "feed") return undefined;
  const generation = Number(parts[2]);
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : undefined;
};

const newestRun = (
  runs: readonly RunRow[],
  sessionId: string,
  onlyRunning: boolean,
): RunRow | undefined => {
  let chosen: RunRow | undefined;
  for (const run of runs) {
    if (run.sessionId !== sessionId) continue;
    if (onlyRunning && run.status !== "running") continue;
    if (chosen === undefined || run.ordinal > chosen.ordinal) chosen = run;
  }
  return chosen;
};

/**
 * The replay point. With no `?gen=`, the client's own `?from=`/`Last-Event-ID`
 * wins, unchanged. With a `?gen=` that does not name this stream's generation,
 * the recorded cursor is on a different basis and only `from: 0` is safe;
 * otherwise `?from=` passes through.
 */
const resumeFrom = (streamId: string, query: EventsQuery): number | undefined => {
  if (query.gen === undefined) return query.from;
  return query.gen === generationOf(streamId) ? query.from : 0;
};

const decodeEvents = async (url: URL): Promise<EventsQuery> =>
  await Effect.runPromise(
    Schema.decodeUnknownEffect(EventsQuerySchema)(Object.fromEntries(url.searchParams)).pipe(
      // The route stays lenient: an undecodable cursor falls back to the header
      // rather than failing a connection the SDK's own writer can still serve.
      Effect.orElseSucceed((): EventsQuery => ({})),
    ),
  );

export const createFeed = (deps: FeedDeps): Feed => {
  const maxChunks = deps.maxChunksPerStream ?? MAX_CHUNKS_PER_STREAM;
  const attached = new Set<string>();
  const writers = new Map<string, SessionWriter>();
  const snapshots = new Map<string, SnapshotEvent>();
  const seen = new Map<string, EntryRecord[]>();
  const queues = new Map<string, Promise<void>>();

  const remember = (session: string, event: AgentEvent): void => {
    if (event.type !== "entry_appended" && event.type !== "message_end") return;
    const entries = seen.get(session);
    if (entries === undefined) {
      seen.set(session, [event.entry]);
      return;
    }
    if (entries.some((entry) => entry.id === event.entry.id)) return;
    entries.push(event.entry);
  };

  const settle = (target: SessionWriter, session: string): void => {
    target.writer.close();
    if (writers.get(session) === target) writers.delete(session);
  };

  /**
   * The snapshot a new segment seeds with. The attach-time snapshot is the base,
   * but entries appended since attach are folded in, so a segment's sequence
   * zero is current rather than stale. Without this, a client that resets its
   * window on a generation change (the documented rule) would drop every entry
   * the previous segment contributed.
   */
  const snapshotFor = (session: string): SnapshotEvent | undefined => {
    const base = snapshots.get(session);
    if (base === undefined) return undefined;
    const observed = seen.get(session);
    if (observed === undefined || observed.length === 0) return base;
    const byId = new Map(base.entries.map((entry) => [entry.id, entry]));
    for (const entry of observed) byId.set(entry.id, entry);
    const entries = [...byId.values()].sort((left, right) => Number(left.id) - Number(right.id));
    return { ...base, entries };
  };

  const seed = (session: string, target: SessionWriter): void => {
    const snapshot = snapshotFor(session);
    if (snapshot === undefined) return;
    target.writer.append(toChunk(encodeSnapshot(snapshot, session, Date.now(), target.generation)));
    target.chunks += 1;
    // Rebase: the base now carries everything seeded, so `seen` only has to hold
    // the entries appended since the last segment rather than the whole session.
    snapshots.set(session, snapshot);
    seen.delete(session);
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

  const ensureOpen = async (
    session: string,
    generation: number,
  ): Promise<SessionWriter | undefined> => {
    const current = writers.get(session);
    if (current !== undefined && current.generation === generation) return current;
    const streamId = streamIdFor(session, generation);
    const status = await runStreams(() => deps.streams.status(streamId));
    if (status !== null && status.state !== "streaming") return undefined;
    const writer = await runStreams(() =>
      deps.streams.open(streamId, { tag: streamTagFor(deps.botId, session) }),
    );
    const opened: SessionWriter = { streamId, generation, writer, chunks: status?.cursor ?? 0 };
    if (opened.chunks === 0) seed(session, opened);
    writers.set(session, opened);
    await sweep(session);
    return opened;
  };

  const rotateTo = async (session: string, generation: number): Promise<void> => {
    const current = writers.get(session);
    if (current !== undefined) settle(current, session);
    await ensureOpen(session, generation);
  };

  const rotateOnRunStart = async (session: string): Promise<void> => {
    const run = newestRun(deps.runs.list(), session, false);
    if (run === undefined) {
      if (writers.get(session) === undefined) await ensureOpen(session, 1);
      return;
    }
    const current = writers.get(session);
    if (current !== undefined && current.generation >= run.ordinal) return;
    await rotateTo(session, run.ordinal);
  };

  const applyEvent = async (session: string, event: AgentEvent): Promise<void> => {
    remember(session, event);
    if (event.type === "snapshot") snapshots.set(session, event);
    if (event.type === "run_start") await rotateOnRunStart(session);
    const target = writers.get(session);
    if (target === undefined) return;
    const frame = encodeFrame(event, Date.now(), target.generation);
    if (frame !== undefined) {
      target.writer.append(toChunk(frame));
      target.chunks += 1;
    }
    if (event.type === "run_end") {
      settle(target, session);
    } else if (target.chunks >= maxChunks) {
      await rotateTo(session, target.generation + 1);
    }
  };

  const appendBatch = async (session: string, batch: readonly AgentEvent[]): Promise<void> => {
    for (const event of batch) {
      await applyEvent(session, event);
    }
  };

  const enqueue = (session: string, batch: readonly AgentEvent[]): Promise<void> => {
    const previous = queues.get(session) ?? Promise.resolve();
    const next = previous
      .then(() => appendBatch(session, batch))
      .catch((cause: unknown) => {
        console.error(`mackbot: feed append for "${session}" failed: ${describeCause(cause)}`);
      });
    queues.set(session, next);
    return next;
  };

  const subscribe = async (session: string): Promise<void> => {
    const stream = await deps.events(session);
    snapshots.set(session, stream.snapshot);
    const run = newestRun(deps.runs.list(), session, true);
    if (run !== undefined) await ensureOpen(session, run.ordinal);
    stream.start((batch) => enqueue(session, batch));
  };

  const attach = async (session: string): Promise<void> => {
    // The guard is taken synchronously, before the first await, so a concurrent
    // second attach in this isolate cannot register a second writer.
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
