import type { Frame } from "@mackbot/contract";
import { AsyncData } from "foldkit";
import { Command, given, message, model, story } from "foldkit/story";
import { describe, expect, test } from "vitest";

import { Transcript } from "../src/api.ts";
import { Message } from "../src/message.ts";
import { FRAME_WINDOW } from "../src/model.ts";
import { update } from "../src/update.ts";
import {
  FIXTURE_NOW,
  entryOf,
  frameOf,
  modelWith,
  statusOf,
  transcriptOf,
} from "./support/fixtures.ts";
import { botChannel, channelOf, entryIds, statusIn, transcriptIn } from "./support/story.ts";

const at = FIXTURE_NOW;

const streamStatus = (generation: number, cursor = 0) => ({
  stream: `feed:hermes:${generation}`,
  generation,
  cursor,
  state: "streaming" as const,
});

const appendFrame = (ids: readonly number[]): Frame => ({
  kind: "append",
  at,
  entries: ids.map((id) => entryOf({ id, text: `entry ${id}` })),
});

const snapshotFrame = (generation: number, ids: readonly number[]): Frame => ({
  kind: "snapshot",
  generation,
  at,
  session: "hermes",
  entries: ids.map((id) => entryOf({ id, text: `entry ${id}` })),
  live: { tools: [], compactions: [] },
  inbox: [],
  usage: { inputTokens: 0, outputTokens: 0, exchanges: 0 },
  transcriptFrom: ids[0] ?? 0,
});

const liveFrame: Frame = { kind: "live", at, live: { tools: [], compactions: [] } };
const inboxFrame: Frame = { kind: "inbox", at, items: [] };
const usageFrame: Frame = {
  kind: "usage",
  at,
  usage: { inputTokens: 10, outputTokens: 5, exchanges: 1 },
};
const runFrame = (phase: "start" | "end"): Frame => ({
  kind: "run",
  phase,
  at,
  operationId: "http:1",
});
const taskFailedFrame: Frame = {
  kind: "task_failed",
  taskId: "task_1",
  task: "compaction",
  message: "the task faulted",
};

const activeRun = () => ({
  ordinal: 1,
  inputs: ["do the thing"],
  startedAt: at - 60_000,
  session: "hermes",
  stream: streamStatus(3),
});

describe("applying a Frame", () => {
  test("append merges entries and advances the resume cursor", () => {
    const seeded = {
      ...modelWith(),
      channels: {
        hermes: botChannel("hermes", {
          transcript: AsyncData.succeed(
            transcriptOf({ entries: [entryOf({ id: 1, text: "one" })] }),
          ),
          stream: { phase: "live", generation: 3, lastSeq: 0, attempt: 0 },
        }),
      },
    };

    story(
      update,
      given(seeded),
      message(Message.FrameReceived(frameOf(appendFrame([2, 3]), 7))),
      Command.expectNone(),
      model((m) => {
        expect(entryIds(m, "hermes")).toEqual([1, 2, 3]);
        const channel = channelOf(m, "hermes");
        expect(channel.stream.lastSeq).toBe(7);
        expect(channel.stream.generation).toBe(3);
        expect(channel.frames).toHaveLength(1);
      }),
    );
  });

  test("a snapshot reseeds the generation and resets the retry budget", () => {
    const seeded = {
      ...modelWith(),
      channels: {
        hermes: botChannel("hermes", {
          transcript: AsyncData.succeed(
            transcriptOf({ entries: [entryOf({ id: 1, text: "one" })] }),
          ),
          stream: { phase: "live", generation: 3, lastSeq: 40, attempt: 4 },
        }),
      },
    };

    story(
      update,
      given(seeded),
      message(Message.FrameReceived(frameOf(snapshotFrame(5, [1, 2]), 1))),
      Command.expectNone(),
      model((m) => {
        const stream = channelOf(m, "hermes").stream;
        expect(stream.generation).toBe(5);
        expect(stream.lastSeq).toBe(1);
        expect(stream.attempt).toBe(0);
        expect(entryIds(m, "hermes")).toEqual([1, 2]);
      }),
    );
  });

  test("a same-generation frame keeps the retry budget", () => {
    const seeded = {
      ...modelWith(),
      channels: {
        hermes: botChannel("hermes", {
          transcript: AsyncData.succeed(transcriptOf()),
          stream: { phase: "live", generation: 3, lastSeq: 40, attempt: 4 },
        }),
      },
    };

    story(
      update,
      given(seeded),
      message(Message.FrameReceived(frameOf(appendFrame([2]), 9))),
      Command.expectNone(),
      model((m) => {
        const stream = channelOf(m, "hermes").stream;
        expect(stream.generation).toBe(3);
        expect(stream.lastSeq).toBe(9);
        expect(stream.attempt).toBe(4);
      }),
    );
  });

  test("a run frame's end removes the active run", () => {
    const seeded = {
      ...modelWith(),
      channels: {
        hermes: botChannel("hermes", {
          status: AsyncData.succeed(statusOf({ busy: true, activeRun: activeRun() })),
        }),
      },
    };

    story(
      update,
      given(seeded),
      message(Message.FrameReceived(frameOf(runFrame("start"), 1))),
      model((m) => {
        expect(statusIn(m, "hermes").activeRun).toBeDefined();
      }),
      message(Message.FrameReceived(frameOf(runFrame("end"), 2))),
      Command.expectNone(),
      model((m) => {
        expect(statusIn(m, "hermes").activeRun).toBeUndefined();
        expect(channelOf(m, "hermes").stream.lastSeq).toBe(2);
      }),
    );
  });

  test("task_failed also removes the active run", () => {
    const seeded = {
      ...modelWith(),
      channels: {
        hermes: botChannel("hermes", {
          status: AsyncData.succeed(statusOf({ busy: true, activeRun: activeRun() })),
        }),
      },
    };

    story(
      update,
      given(seeded),
      message(Message.FrameReceived(frameOf(taskFailedFrame, 4))),
      Command.expectNone(),
      model((m) => {
        expect(statusIn(m, "hermes").activeRun).toBeUndefined();
        expect(channelOf(m, "hermes").stream.lastSeq).toBe(4);
      }),
    );
  });

  test("live, inbox and usage frames only advance the cursor", () => {
    const page = transcriptOf({ entries: [entryOf({ id: 1, text: "one" })] });
    const seeded = {
      ...modelWith(),
      channels: {
        hermes: botChannel("hermes", {
          transcript: AsyncData.succeed(page),
          stream: { phase: "live", generation: 3, lastSeq: 0, attempt: 0 },
        }),
      },
    };

    story(
      update,
      given(seeded),
      message(Message.FrameReceived(frameOf(liveFrame, 1))),
      message(Message.FrameReceived(frameOf(inboxFrame, 2))),
      message(Message.FrameReceived(frameOf(usageFrame, 3))),
      Command.expectNone(),
      model((m) => {
        const channel = channelOf(m, "hermes");
        expect(channel.stream.lastSeq).toBe(3);
        expect(channel.frames).toHaveLength(3);
        expect(transcriptIn(m, "hermes").entries).toEqual(page.entries);
      }),
    );
  });

  test("the frame window keeps the newest frames", () => {
    const existing = Array.from({ length: FRAME_WINDOW }, (_, index) => {
      const id = index + 1;
      return frameOf(appendFrame([id]), id).frame;
    });
    const seeded = {
      ...modelWith(),
      channels: { hermes: botChannel("hermes", { frames: existing }) },
    };

    story(
      update,
      given(seeded),
      message(Message.FrameReceived(frameOf(appendFrame([FRAME_WINDOW + 1]), FRAME_WINDOW + 1))),
      Command.expectNone(),
      model((m) => {
        const { frames } = channelOf(m, "hermes");
        expect(frames).toHaveLength(FRAME_WINDOW);
        const first = frames[0];
        const last = frames[frames.length - 1];
        expect(first?.kind === "append" ? first.entries[0]?.id : undefined).toBe(2);
        expect(last?.kind === "append" ? last.entries[0]?.id : undefined).toBe(FRAME_WINDOW + 1);
      }),
    );
  });
});

describe("stream reconnection", () => {
  test("a drop spends one attempt and marks the stream retrying", () => {
    const seeded = {
      ...modelWith(),
      channels: {
        hermes: botChannel("hermes", {
          stream: { phase: "live", generation: 3, lastSeq: 9, attempt: 0 },
        }),
      },
    };

    story(
      update,
      given(seeded),
      message(Message.StreamDropped({ bot: "hermes" })),
      Command.expectNone(),
      model((m) => {
        const stream = channelOf(m, "hermes").stream;
        expect(stream.attempt).toBe(1);
        expect(stream.phase).toBe("retrying");
        expect(stream.lastSeq).toBe(9);
      }),
    );
  });

  test("the fifth attempt is still retryable", () => {
    const seeded = {
      ...modelWith(),
      channels: {
        hermes: botChannel("hermes", {
          stream: { phase: "live", generation: 3, lastSeq: 0, attempt: 4 },
        }),
      },
    };

    story(
      update,
      given(seeded),
      message(Message.StreamDropped({ bot: "hermes" })),
      Command.expectNone(),
      model((m) => {
        const stream = channelOf(m, "hermes").stream;
        expect(stream.attempt).toBe(5);
        expect(stream.phase).toBe("retrying");
      }),
    );
  });

  test("a drop past the attempt budget closes the stream", () => {
    const seeded = {
      ...modelWith(),
      channels: {
        hermes: botChannel("hermes", {
          stream: { phase: "retrying", generation: 3, lastSeq: 0, attempt: 5 },
        }),
      },
    };

    story(
      update,
      given(seeded),
      message(Message.StreamDropped({ bot: "hermes" })),
      Command.expectNone(),
      model((m) => {
        const stream = channelOf(m, "hermes").stream;
        expect(stream.attempt).toBe(6);
        expect(stream.phase).toBe("closed");
      }),
    );
  });

  test("a closed stream ignores further drops", () => {
    const seeded = {
      ...modelWith(),
      channels: {
        hermes: botChannel("hermes", {
          stream: { phase: "closed", generation: 3, lastSeq: 0, attempt: 6 },
        }),
      },
    };

    story(
      update,
      given(seeded),
      message(Message.StreamDropped({ bot: "hermes" })),
      Command.expectNone(),
      model((m) => {
        const stream = channelOf(m, "hermes").stream;
        expect(stream.attempt).toBe(6);
        expect(stream.phase).toBe("closed");
      }),
    );
  });

  test("StreamClosed marks the stream closed and refreshes the transcript", () => {
    const seeded = {
      ...modelWith(),
      channels: {
        hermes: botChannel("hermes", {
          stream: { phase: "live", generation: 3, lastSeq: 11, attempt: 0 },
          transcript: AsyncData.succeed(transcriptOf()),
        }),
      },
    };

    story(
      update,
      given(seeded),
      message(Message.StreamClosed({ bot: "hermes" })),
      Command.expectExact(Transcript({ bot: "hermes" })),
      model((m) => {
        expect(channelOf(m, "hermes").stream.phase).toBe("closed");
        expect(channelOf(m, "hermes").stream.lastSeq).toBe(11);
      }),
      Command.resolve(
        Transcript({ bot: "hermes" }),
        Message.TranscriptLoaded({ bot: "hermes", page: transcriptOf({ session: "hermes" }) }),
      ),
    );
  });
});

describe("polled transcript", () => {
  test("PolledTranscript asks for the transcript and marks it refreshing", () => {
    const seeded = {
      ...modelWith(),
      channels: { hermes: botChannel("hermes", { refreshing: false }) },
    };

    story(
      update,
      given(seeded),
      message(Message.PolledTranscript({ bot: "hermes" })),
      Command.expectExact(Transcript({ bot: "hermes" })),
      model((m) => {
        expect(channelOf(m, "hermes").refreshing).toBe(true);
      }),
      Command.resolve(
        Transcript({ bot: "hermes" }),
        Message.TranscriptLoaded({ bot: "hermes", page: transcriptOf() }),
      ),
      model((m) => {
        expect(channelOf(m, "hermes").refreshing).toBe(false);
      }),
    );
  });

  test("PolledTranscript while a transcript request is in flight is a no-op", () => {
    const seeded = {
      ...modelWith(),
      channels: { hermes: botChannel("hermes", { refreshing: true }) },
    };

    story(
      update,
      given(seeded),
      message(Message.PolledTranscript({ bot: "hermes" })),
      Command.expectNone(),
      model((m) => {
        expect(channelOf(m, "hermes").refreshing).toBe(true);
      }),
    );
  });

  test("PolledTranscript for a bot with no channel is a no-op", () => {
    story(
      update,
      given(modelWith()),
      message(Message.PolledTranscript({ bot: "hermes" })),
      Command.expectNone(),
      model((m) => {
        expect(m.channels.hermes).toBeUndefined();
      }),
    );
  });
});
