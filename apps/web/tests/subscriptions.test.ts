/**
 * The subscriptions' Model-facing halves: which connections the Model asks
 * for, when the open transcript is polled, and which changes are a reconnect.
 * The transports themselves are the browser's; what is tested here is the
 * decision about them.
 */
import { AsyncData } from "foldkit";
import { describe, expect, test } from "vitest";

import { Screen } from "../src/model.ts";
import type { Model } from "../src/model.ts";
import {
  AWAIT_ANSWER_MS,
  activeSources,
  chatWatching,
  seqOfEventId,
  sourcesEquivalence,
  streamWanted,
} from "../src/subscriptions.ts";
import {
  FIXTURE_NOW,
  approvalOf,
  entryOf,
  modelWith,
  statusOf,
  transcriptOf,
} from "./support/fixtures.ts";
import { botChannel } from "./support/story.ts";

const stream = (generation: number) => ({
  stream: `feed:hermes:${generation}`,
  generation,
  cursor: 0,
  state: "streaming" as const,
});

const running = statusOf({
  busy: true,
  activeRun: {
    ordinal: 1,
    inputs: ["do the thing"],
    startedAt: FIXTURE_NOW - 60_000,
    session: "hermes",
    stream: stream(3),
  },
  activeStream: stream(3),
});

const fleet = (screen: Model["screen"]): Model => ({
  ...modelWith(),
  screen,
  channels: {
    hermes: botChannel("hermes", {
      status: AsyncData.succeed(running),
      stream: { phase: "live", generation: 3, lastSeq: 7, attempt: 1, failures: 0 },
    }),
    // Waiting on a human is the other reason to hold a stream open.
    atlas: botChannel("atlas", {
      status: AsyncData.succeed(
        statusOf({
          id: "atlas",
          approvals: [approvalOf({ bot: "atlas" })],
          activeStream: stream(2),
        }),
      ),
      stream: { phase: "idle", generation: 2, lastSeq: 0, attempt: 0, failures: 0 },
    }),
    // Idle: nothing to watch, so no connection.
    scribe: botChannel("scribe", {
      status: AsyncData.succeed(statusOf({ id: "scribe", activeStream: stream(1) })),
    }),
  },
});

describe("streamWanted", () => {
  test("a closed stream is not reopened, whatever the bot is doing", () => {
    const channel = botChannel("hermes", {
      status: AsyncData.succeed(running),
      stream: { phase: "closed", generation: 3, lastSeq: 7, attempt: 6, failures: 6 },
    });

    expect(streamWanted(channel)).toBe(false);
  });

  test("a bot with no status yet has nothing to attach to", () => {
    expect(streamWanted(botChannel("hermes"))).toBe(false);
    expect(streamWanted(undefined)).toBe(false);
  });
});

describe("activeSources", () => {
  test("the home holds a stream for each bot that is running or blocked, in bot order", () => {
    expect(activeSources(fleet(Screen.Home())).map((source) => source.bot)).toEqual([
      "atlas",
      "hermes",
    ]);
  });

  test("a transcript holds only its own bot's stream, resuming from the cursor", () => {
    expect(activeSources(fleet(Screen.Transcript({ bot: "hermes" })))).toEqual([
      {
        bot: "hermes",
        stream: "feed:hermes:3",
        generation: 3,
        lastSeq: 7,
        attempt: 1,
        failures: 0,
      },
    ]);
  });

  test("the roster screen follows no bot", () => {
    expect(activeSources(fleet(Screen.Bots()))).toEqual([]);
  });
});

describe("sourcesEquivalence", () => {
  const base = activeSources(fleet(Screen.Transcript({ bot: "hermes" })));
  const changed = (change: Partial<(typeof base)[number]>) => ({
    sources: base.map((source) => ({ ...source, ...change })),
  });

  test("a frame moving the cursor or clearing failures keeps the connection", () => {
    expect(sourcesEquivalence({ sources: base }, changed({ lastSeq: 99 }))).toBe(true);
    expect(sourcesEquivalence({ sources: base }, changed({ failures: 3 }))).toBe(true);
  });

  test("a drop, a new generation or a new stream is a new connection", () => {
    expect(sourcesEquivalence({ sources: base }, changed({ attempt: 2 }))).toBe(false);
    expect(sourcesEquivalence({ sources: base }, changed({ generation: 4 }))).toBe(false);
    expect(sourcesEquivalence({ sources: base }, changed({ stream: "feed:hermes:4" }))).toBe(false);
  });
});

describe("chatWatching", () => {
  const quiet = statusOf();
  const endingOnUser = (at: number) =>
    botChannel("hermes", {
      status: AsyncData.succeed(quiet),
      transcript: AsyncData.succeed(
        transcriptOf({ entries: [entryOf({ id: 1, role: "user", text: "Anyone?", at })] }),
      ),
    });

  test("a send in flight or a message not yet recorded is watched", () => {
    expect(chatWatching(botChannel("hermes", { sending: true }), FIXTURE_NOW)).toBe(true);
    expect(
      chatWatching(botChannel("hermes", { pending: [{ text: "hi", after: 0 }] }), FIXTURE_NOW),
    ).toBe(true);
  });

  test("a recent unanswered message is watched", () => {
    expect(chatWatching(endingOnUser(FIXTURE_NOW - 10_000), FIXTURE_NOW)).toBe(true);
  });

  test("an unanswered message stops being watched once the wait is over", () => {
    expect(chatWatching(endingOnUser(FIXTURE_NOW - AWAIT_ANSWER_MS), FIXTURE_NOW)).toBe(false);
  });

  test("a thread that ends on the bot's answer is not watched", () => {
    const answered = botChannel("hermes", {
      status: AsyncData.succeed(quiet),
      transcript: AsyncData.succeed(transcriptOf()),
    });

    expect(chatWatching(answered, FIXTURE_NOW)).toBe(false);
  });
});

describe("seqOfEventId", () => {
  test("a frame without an id is no position at all, not position zero", () => {
    expect(seqOfEventId("")).toBeUndefined();
    expect(seqOfEventId("abc")).toBeUndefined();
    expect(seqOfEventId("-1")).toBeUndefined();
    expect(seqOfEventId("42")).toBe(42);
  });
});
