import { AsyncData } from "foldkit";
import { Command, given, message, model, story } from "foldkit/story";
import { describe, expect, test } from "vitest";

import { Chat, Status, Transcript } from "../src/api.ts";
import { Message } from "../src/message.ts";
import { update } from "../src/update.ts";
import { FIXTURE_NOW, modelWith, statusOf, transcriptOf } from "./support/fixtures.ts";
import {
  botChannel,
  channelOf,
  dataOf,
  entryIds,
  statusErrorIn,
  statusIn,
  transcriptErrorIn,
  transcriptIn,
} from "./support/story.ts";

const at = FIXTURE_NOW;

const streamOf = (generation: number) => ({
  stream: `feed:hermes:${generation}`,
  generation,
  cursor: 0,
  state: "streaming" as const,
});

describe("polling gate", () => {
  test("PolledStatus asks for Status and records the request in flight", () => {
    story(
      update,
      given(modelWith({ polling: false })),
      message(Message.PolledStatus()),
      Command.expectExact(Status),
      model((m) => {
        expect(m.polling).toBe(true);
      }),
      Command.resolve(Status, Message.StatusLoaded({ bots: {}, errors: {}, at })),
      model((m) => {
        expect(m.polling).toBe(false);
        expect(m.now).toBe(at);
      }),
    );
  });

  test("PolledStatus while a status request is in flight is a no-op", () => {
    story(
      update,
      given(modelWith({ polling: true })),
      message(Message.PolledStatus()),
      Command.expectNone(),
      model((m) => {
        expect(m.polling).toBe(true);
      }),
    );
  });
});

describe("StatusLoaded", () => {
  test("fills each bot's channel, seeds the clock and asks only for missing transcripts", () => {
    const hermesTranscript = transcriptOf({ session: "hermes" });
    const seeded = {
      ...modelWith({ polling: true, now: 0 }),
      channels: {
        hermes: botChannel("hermes", { transcript: AsyncData.succeed(hermesTranscript) }),
        scribe: botChannel("scribe"),
      },
    };

    story(
      update,
      given(seeded),
      message(
        Message.StatusLoaded({
          bots: {
            hermes: statusOf(),
            scribe: statusOf({ id: "scribe" }),
          },
          errors: { atlas: "the bot did not answer" },
          at,
        }),
      ),
      Command.expectExact(Transcript({ bot: "scribe" })),
      Command.resolve(
        Transcript({ bot: "scribe" }),
        Message.TranscriptLoaded({ bot: "scribe", page: transcriptOf({ session: "scribe" }) }),
      ),
      model((m) => {
        expect(m.polling).toBe(false);
        expect(m.now).toBe(at);
        expect(dataOf(m.roster)).toBeNull();

        expect(statusIn(m, "hermes").id).toBe("hermes");
        expect(statusIn(m, "scribe").id).toBe("scribe");
        expect(statusErrorIn(m, "atlas")).toBe("the bot did not answer");

        // A transcript already in hand is not fetched again.
        expect(transcriptIn(m, "hermes")).toEqual(hermesTranscript);
        expect(transcriptIn(m, "scribe").session).toBe("scribe");
      }),
    );
  });

  test("a same-generation status keeps the stream cursor and retry budget", () => {
    const seeded = {
      ...modelWith({ polling: true }),
      channels: {
        hermes: botChannel("hermes", {
          transcript: AsyncData.succeed(transcriptOf()),
          stream: { phase: "live", generation: 3, lastSeq: 40, attempt: 2 },
        }),
      },
    };

    story(
      update,
      given(seeded),
      message(
        Message.StatusLoaded({
          bots: { hermes: statusOf({ activeStream: streamOf(3) }) },
          errors: {},
          at,
        }),
      ),
      model((m) => {
        const stream = channelOf(m, "hermes").stream;
        expect(stream.generation).toBe(3);
        expect(stream.lastSeq).toBe(40);
        expect(stream.attempt).toBe(2);
        expect(stream.phase).toBe("live");
      }),
    );
  });

  test("a new stream generation resets the cursor and retry budget", () => {
    const seeded = {
      ...modelWith({ polling: true }),
      channels: {
        hermes: botChannel("hermes", {
          transcript: AsyncData.succeed(transcriptOf()),
          stream: { phase: "live", generation: 3, lastSeq: 40, attempt: 2 },
        }),
      },
    };

    story(
      update,
      given(seeded),
      message(
        Message.StatusLoaded({
          bots: { hermes: statusOf({ activeStream: streamOf(4) }) },
          errors: {},
          at,
        }),
      ),
      model((m) => {
        const stream = channelOf(m, "hermes").stream;
        expect(stream.generation).toBe(4);
        expect(stream.lastSeq).toBe(0);
        expect(stream.attempt).toBe(0);
      }),
    );
  });
});

describe("sending a chat message", () => {
  test("SubmittedChat trims the draft, clears it and emits Chat with the trimmed text", () => {
    const seeded = {
      ...modelWith({ toast: { text: "an older toast" } }),
      channels: {
        hermes: botChannel("hermes", {
          draft: "   hello there   ",
          transcript: AsyncData.succeed(transcriptOf()),
        }),
      },
    };

    story(
      update,
      given(seeded),
      message(Message.SubmittedChat({ bot: "hermes" })),
      Command.expectExact(Chat({ bot: "hermes", text: "hello there" })),
      model((m) => {
        const channel = channelOf(m, "hermes");
        expect(channel.draft).toBe("");
        expect(channel.sending).toBe(true);
        expect(channel.pending).toEqual(["hello there"]);
        expect(m.toast).toBeNull();
      }),
      Command.resolve(
        Chat({ bot: "hermes", text: "hello there" }),
        Message.ChatSent({ bot: "hermes", operationId: "http:1" }),
      ),
      // ChatSent opens a run: it asks for the status and the transcript.
      Command.resolve(Status, Message.StatusLoaded({ bots: {}, errors: {}, at })),
      Command.resolve(
        Transcript({ bot: "hermes" }),
        Message.TranscriptLoaded({ bot: "hermes", page: transcriptOf() }),
      ),
    );
  });

  test("a blank draft sends nothing", () => {
    const seeded = {
      ...modelWith(),
      channels: { hermes: botChannel("hermes", { draft: "   " }) },
    };

    story(
      update,
      given(seeded),
      message(Message.SubmittedChat({ bot: "hermes" })),
      Command.expectNone(),
      model((m) => {
        const channel = channelOf(m, "hermes");
        expect(channel.draft).toBe("   ");
        expect(channel.sending).toBe(false);
        expect(channel.pending).toEqual([]);
      }),
    );
  });

  test("a send while one is in flight is a no-op", () => {
    const seeded = {
      ...modelWith(),
      channels: { hermes: botChannel("hermes", { draft: "hello", sending: true }) },
    };

    story(
      update,
      given(seeded),
      message(Message.SubmittedChat({ bot: "hermes" })),
      Command.expectNone(),
      model((m) => {
        const channel = channelOf(m, "hermes");
        expect(channel.draft).toBe("hello");
        expect(channel.sending).toBe(true);
        expect(channel.pending).toEqual([]);
      }),
    );
  });

  test("ChatSent clears sending, marks the transcript refreshing and asks for both routes", () => {
    const seeded = {
      ...modelWith(),
      channels: {
        hermes: botChannel("hermes", {
          sending: true,
          refreshing: false,
          transcript: AsyncData.succeed(transcriptOf()),
        }),
      },
    };

    story(
      update,
      given(seeded),
      message(Message.ChatSent({ bot: "hermes", operationId: "http:1" })),
      Command.expectExact(Status, Transcript({ bot: "hermes" })),
      model((m) => {
        const channel = channelOf(m, "hermes");
        expect(channel.sending).toBe(false);
        expect(channel.refreshing).toBe(true);
      }),
      Command.resolve(Status, Message.StatusLoaded({ bots: {}, errors: {}, at })),
      Command.resolve(
        Transcript({ bot: "hermes" }),
        Message.TranscriptLoaded({ bot: "hermes", page: transcriptOf() }),
      ),
      model((m) => {
        expect(channelOf(m, "hermes").refreshing).toBe(false);
      }),
    );
  });

  test("ChatFailed restores the text and explains what happened", () => {
    const seeded = {
      ...modelWith(),
      channels: {
        hermes: botChannel("hermes", {
          draft: "",
          sending: true,
          pending: ["hello"],
        }),
      },
    };

    story(
      update,
      given(seeded),
      message(Message.ChatFailed({ bot: "hermes", error: "connection reset" })),
      Command.expectNone(),
      model((m) => {
        const channel = channelOf(m, "hermes");
        expect(channel.draft).toBe("hello");
        expect(channel.pending).toEqual([]);
        expect(channel.sending).toBe(false);
        expect(m.toast?.text).toBe(
          "Couldn't reach Hermes (connection reset). Your message is still here.",
        );
      }),
    );
  });

  test("ChatFailed keeps text the person has already typed", () => {
    const seeded = {
      ...modelWith(),
      channels: {
        hermes: botChannel("hermes", {
          draft: "a newer thought",
          sending: true,
          pending: ["the failed one"],
        }),
      },
    };

    story(
      update,
      given(seeded),
      message(Message.ChatFailed({ bot: "hermes", error: "timeout" })),
      Command.expectNone(),
      model((m) => {
        const channel = channelOf(m, "hermes");
        expect(channel.draft).toBe("a newer thought");
        expect(channel.pending).toEqual([]);
        expect(channel.sending).toBe(false);
        expect(m.toast?.text).toBe("Couldn't reach Hermes (timeout). Your message is still here.");
      }),
    );
  });
});

describe("transcript merging", () => {
  test("a newest-page reload keeps older entries and the older cursor", () => {
    const previous = transcriptOf({
      entries: [
        { id: 1, kind: "message", role: "user", text: "one" },
        { id: 2, kind: "message", role: "assistant", text: "two" },
        { id: 3, kind: "message", role: "assistant", text: "three" },
      ],
      nextBefore: 1,
    });
    const seeded = {
      ...modelWith(),
      channels: { hermes: botChannel("hermes", { transcript: AsyncData.succeed(previous) }) },
    };

    story(
      update,
      given(seeded),
      message(
        Message.TranscriptLoaded({
          bot: "hermes",
          page: transcriptOf({
            entries: [
              { id: 3, kind: "message", role: "assistant", text: "three again" },
              { id: 4, kind: "message", role: "assistant", text: "four" },
            ],
            nextBefore: 3,
          }),
        }),
      ),
      model((m) => {
        const page = transcriptIn(m, "hermes");
        expect(entryIds(m, "hermes")).toEqual([1, 2, 3, 4]);
        expect(page.entries.find((entry) => entry.id === 3)?.text).toBe("three again");
        expect(page.nextBefore).toBe(1);
      }),
    );
  });

  test("an earlier page is prepended in id order", () => {
    const previous = transcriptOf({
      entries: [
        { id: 5, kind: "message", role: "user", text: "five" },
        { id: 6, kind: "message", role: "assistant", text: "six" },
      ],
    });
    const seeded = {
      ...modelWith(),
      channels: { hermes: botChannel("hermes", { transcript: AsyncData.succeed(previous) }) },
    };

    story(
      update,
      given(seeded),
      message(
        Message.TranscriptLoaded({
          bot: "hermes",
          before: 5,
          page: transcriptOf({
            entries: [
              { id: 3, kind: "message", role: "user", text: "three" },
              { id: 4, kind: "message", role: "assistant", text: "four" },
            ],
          }),
        }),
      ),
      model((m) => {
        expect(entryIds(m, "hermes")).toEqual([3, 4, 5, 6]);
      }),
    );
  });

  test("duplicate ids collapse to one entry", () => {
    const previous = transcriptOf({
      entries: [
        { id: 1, kind: "message", role: "user", text: "one" },
        { id: 2, kind: "message", role: "assistant", text: "two" },
      ],
    });
    const seeded = {
      ...modelWith(),
      channels: { hermes: botChannel("hermes", { transcript: AsyncData.succeed(previous) }) },
    };

    story(
      update,
      given(seeded),
      message(
        Message.TranscriptLoaded({
          bot: "hermes",
          page: transcriptOf({
            entries: [
              { id: 2, kind: "message", role: "assistant", text: "two updated" },
              { id: 3, kind: "message", role: "assistant", text: "three" },
            ],
          }),
        }),
      ),
      model((m) => {
        expect(entryIds(m, "hermes")).toEqual([1, 2, 3]);
        const twos = transcriptIn(m, "hermes").entries.filter((entry) => entry.id === 2);
        expect(twos).toHaveLength(1);
        expect(twos[0]?.text).toBe("two updated");
      }),
    );
  });

  test("TranscriptLoaded retires only the pending messages the server recorded", () => {
    const seeded = {
      ...modelWith(),
      channels: {
        hermes: botChannel("hermes", { pending: ["hello", "still waiting"] }),
      },
    };

    story(
      update,
      given(seeded),
      message(
        Message.TranscriptLoaded({
          bot: "hermes",
          page: transcriptOf({
            entries: [
              { id: 1, kind: "message", role: "user", text: "hello" },
              { id: 2, kind: "message", role: "assistant", text: "hi" },
            ],
          }),
        }),
      ),
      model((m) => {
        expect(channelOf(m, "hermes").pending).toEqual(["still waiting"]);
      }),
    );
  });
});

describe("transcript failures", () => {
  test("a first-load failure becomes the channel's error", () => {
    const seeded = {
      ...modelWith(),
      channels: { hermes: botChannel("hermes", { refreshing: true }) },
    };

    story(
      update,
      given(seeded),
      message(Message.TranscriptFailed({ bot: "hermes", error: "no route" })),
      Command.expectNone(),
      model((m) => {
        const channel = channelOf(m, "hermes");
        expect(channel.transcript._tag).toBe("Failure");
        expect(transcriptErrorIn(m, "hermes")).toBe("no route");
        expect(channel.refreshing).toBe(false);
      }),
    );
  });

  test("a later failure keeps the rendered entries", () => {
    const previous = transcriptOf({
      entries: [
        { id: 1, kind: "message", role: "user", text: "one" },
        { id: 2, kind: "message", role: "assistant", text: "two" },
      ],
    });
    const seeded = {
      ...modelWith(),
      channels: {
        hermes: botChannel("hermes", {
          transcript: AsyncData.succeed(previous),
          refreshing: true,
        }),
      },
    };

    story(
      update,
      given(seeded),
      message(Message.TranscriptFailed({ bot: "hermes", error: "no route" })),
      Command.expectNone(),
      model((m) => {
        const channel = channelOf(m, "hermes");
        expect(channel.transcript._tag).toBe("Success");
        expect(transcriptIn(m, "hermes")).toEqual(previous);
        expect(channel.refreshing).toBe(false);
      }),
    );
  });
});
