import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import type { StreamJson, Streams, StreamStatus, StreamWriter } from "agents/streams";
import { describe, expect, test } from "vitest";

import { RETENTION_STREAMS, createFeed, resumeFrom } from "../src/feed.ts";
import type { WatchStart } from "../src/feed.ts";

interface FakeStream {
  readonly streamId: string;
  readonly tag: string | undefined;
  state: StreamStatus["state"];
  readonly chunks: StreamJson[];
}

/**
 * The slice of `Streams` the feed uses, in memory. `failNextAppend` makes the
 * next append throw, the way a stream another isolate settled refuses one.
 */
const memoryStreams = () => {
  const streams: FakeStream[] = [];
  const reads: Array<{ streamId: string; from: number | undefined }> = [];
  let failNextAppend = false;
  const find = (streamId: string) => streams.find((stream) => stream.streamId === streamId);
  const statusOf = (stream: FakeStream): StreamStatus =>
    // SAFETY: the feed reads only these fields of a status.
    ({
      streamId: stream.streamId,
      state: stream.state,
      cursor: stream.chunks.length,
    }) as StreamStatus;
  const fake = {
    status: async (streamId: string) => {
      const stream = find(streamId);
      return stream === undefined ? null : statusOf(stream);
    },
    list: async (options: { tag?: string; limit?: number }) =>
      streams
        .filter((stream) => stream.tag === options.tag)
        .reverse()
        .slice(0, options.limit)
        .map(statusOf),
    open: async (streamId: string, options?: { tag?: string }): Promise<StreamWriter> => {
      let stream = find(streamId);
      if (stream === undefined) {
        stream = { streamId, tag: options?.tag, state: "streaming", chunks: [] };
        streams.push(stream);
      }
      if (stream.state !== "streaming") throw new Error(`${streamId} is closed`);
      const target = stream;
      // SAFETY: the feed uses only append and close.
      return {
        append: (chunk: StreamJson) => {
          if (failNextAppend) {
            failNextAppend = false;
            throw new Error("stream closed");
          }
          target.chunks.push(chunk);
          return target.chunks.length - 1;
        },
        close: () => {
          target.state = "completed";
        },
      } as StreamWriter;
    },
    delete: async (streamId: string) => {
      const index = streams.findIndex((stream) => stream.streamId === streamId);
      if (index >= 0) streams.splice(index, 1);
      return index >= 0;
    },
    async *readBatches(streamId: string, options: { from?: number }) {
      reads.push({ streamId, from: options.from });
      yield [];
    },
  };
  return {
    // SAFETY: the structural slice above is everything the feed and
    // `sseResponse` call.
    streams: fake as Streams,
    all: streams,
    reads,
    failNextAppend: () => {
      failNextAppend = true;
    },
  };
};

const entry = (id: number): EntryRecord =>
  // SAFETY: pi's ids are branded numbers; the brand is all this adds.
  ({ id, conversationId: 1, kind: "note" }) as EntryRecord;

const view = (ids: readonly number[]): ConversationView =>
  // SAFETY: the feed reads only `entries` and `docs` of a view.
  ({ conversation: {}, entries: ids.map(entry), docs: {} }) as ConversationView;

interface Chunk {
  readonly kind: string;
  readonly generation?: number;
  readonly entries?: ReadonlyArray<{ readonly id: number }>;
}

/** The frames a segment holds, read back the way a client parses them. */
const chunksOf = (stream: FakeStream | undefined): Chunk[] =>
  JSON.parse(JSON.stringify(stream?.chunks ?? []));

/** A feed for session "root" whose commits the test drives. */
const harness = (memory: ReturnType<typeof memoryStreams>, maxChunksPerStream?: number) => {
  let listener: ((value: ConversationView) => Promise<void>) | undefined;
  let initial = view([1]);
  const feed = createFeed({
    botId: "hermes",
    streams: memory.streams,
    watch: async (): Promise<WatchStart> => ({
      value: initial,
      start: (next) => {
        listener = next;
      },
    }),
    submissions: async () => [],
    sessionOf: async () => "root",
    maxChunksPerStream,
  });
  return {
    feed,
    seedWith: (ids: readonly number[]) => {
      initial = view(ids);
    },
    commit: async (ids: readonly number[]) => {
      if (listener === undefined) throw new Error("the feed is not attached");
      await listener(view(ids));
    },
  };
};

/** Every entry id the session's segments carry, in the order a reader sees them. */
const deliveredIds = (memory: ReturnType<typeof memoryStreams>): number[] =>
  memory.all.flatMap((stream) =>
    chunksOf(stream).flatMap((chunk) => (chunk.entries ?? []).map((item) => item.id)),
  );

describe("feed", () => {
  test("a segment starts with a snapshot, and a commit appends only the new entries", async () => {
    const memory = memoryStreams();
    const { feed, commit } = harness(memory);
    await feed.attach("root");
    await commit([1, 2, 3]);

    const chunks = chunksOf(memory.all[0]);
    expect(memory.all[0]?.streamId).toBe("feed:root:1");
    expect(chunks[0]).toMatchObject({ kind: "snapshot", generation: 1 });
    expect(chunks[0]?.entries?.map((item) => item.id)).toEqual([1]);
    expect(chunks.filter((chunk) => chunk.kind === "append")).toMatchObject([
      { entries: [{ id: 2 }, { id: 3 }] },
    ]);
  });

  test("rotation settles the full segment and opens the next generation with a snapshot", async () => {
    const memory = memoryStreams();
    const { feed, commit } = harness(memory, 3);
    await feed.attach("root");
    await commit([1, 2]);
    await commit([1, 2, 3]);

    expect(memory.all.map((stream) => [stream.streamId, stream.state])).toEqual([
      ["feed:root:1", "completed"],
      ["feed:root:2", "streaming"],
    ]);
    const next = chunksOf(memory.all[1]);
    expect(next[0]).toMatchObject({ kind: "snapshot", generation: 2 });
    expect(next[0]?.entries?.map((item) => item.id)).toEqual([1, 2, 3]);
  });

  test("rotation keeps only the newest segments", async () => {
    const memory = memoryStreams();
    const { feed, commit } = harness(memory, 2);
    await feed.attach("root");
    for (let last = 2; last < 2 + RETENTION_STREAMS * 2; last += 1) {
      await commit(Array.from({ length: last }, (_, index) => index + 1));
    }
    expect(memory.all.length).toBeLessThanOrEqual(RETENTION_STREAMS);
    expect(memory.all.at(-1)?.state).toBe("streaming");
  });

  test("a new isolate settles the segment it finds streaming and starts one past it", async () => {
    const memory = memoryStreams();
    await harness(memory).feed.attach("root");
    await harness(memory).feed.attach("root");

    expect(memory.all.map((stream) => [stream.streamId, stream.state])).toEqual([
      ["feed:root:1", "completed"],
      ["feed:root:2", "streaming"],
    ]);
  });

  test("a failed append loses no entries: the next commit carries them in a fresh segment", async () => {
    const memory = memoryStreams();
    const { feed, commit } = harness(memory);
    await feed.attach("root");
    memory.failNextAppend();
    await commit([1, 2]);
    expect(deliveredIds(memory)).toEqual([1]);

    await commit([1, 2]);
    expect(deliveredIds(memory)).toContain(2);
    const newest = chunksOf(memory.all.at(-1));
    expect(newest[0]).toMatchObject({ kind: "snapshot", generation: 2 });
  });

  test("an entry is delivered once when nothing fails", async () => {
    const memory = memoryStreams();
    const { feed, commit } = harness(memory);
    await feed.attach("root");
    await commit([1, 2]);
    await commit([1, 2]);
    await commit([1, 2, 3]);
    expect(deliveredIds(memory)).toEqual([1, 2, 3]);
  });
});

describe("feed resume point", () => {
  const serveWith = async (url: string, headers: Record<string, string> = {}) => {
    const memory = memoryStreams();
    const { feed } = harness(memory);
    const response = await feed.serve(new Request(url, { headers }));
    await response.text();
    return memory.reads[0];
  };

  test("with no generation, Last-Event-ID resumes after the event it names", async () => {
    const read = await serveWith("https://bot/events/hermes", { "Last-Event-ID": "4" });
    expect(read).toEqual({ streamId: "feed:root:1", from: 5 });
  });

  test("a generation that names the stream passes ?from= through", async () => {
    const read = await serveWith("https://bot/events/hermes?gen=1&from=7");
    expect(read?.from).toBe(7);
  });

  test("a generation from another segment replays from its snapshot, whatever the cursor", async () => {
    const read = await serveWith("https://bot/events/hermes?gen=3&from=413", {
      "Last-Event-ID": "412",
    });
    expect(read?.from).toBe(0);
  });

  test("resumeFrom ignores the generation when the client sent none", () => {
    expect(resumeFrom("feed:root:2", { from: 9 })).toBe(9);
    expect(resumeFrom("feed:root:2", {})).toBeUndefined();
    expect(resumeFrom("feed:root:2", { gen: 1, from: 9 })).toBe(0);
  });
});
