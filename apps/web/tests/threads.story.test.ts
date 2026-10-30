/**
 * Story tests for a bot's conversations: the URL that names one, moving
 * between them, starting a new one, and keeping each one's words, sends and
 * stream frames out of the others.
 */
import { Option } from "effect";
import { AsyncData } from "foldkit";
import { Command, given, message, model, story } from "foldkit/story";
import { fromString } from "foldkit/url";
import { describe, expect, test } from "vitest";

import { ArchiveThread, Chat, StartThread, Status, Threads, Transcript } from "../src/api.ts";
import { init } from "../src/main.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { Navigate, pathOf, screenOfPath } from "../src/route.ts";
import { update } from "../src/update.ts";
import {
  entryOf,
  frameOf,
  modelWith,
  statusOf,
  transcriptModel,
  transcriptOf,
} from "./support/fixtures.ts";
import { channelOf, foldMessages, transcriptIn } from "./support/story.ts";
import { settleToast, toastText } from "./support/toast.ts";

const urlOf = (pathname: string) =>
  Option.getOrThrow(fromString(`https://mackbot.test${pathname}`));

const emptyList = (bot: string) => Message.ThreadsLoaded({ bot, threads: { bot, threads: [] } });

/** Hermes's main conversation on screen, loaded, with a half-written message. */
const onMain = () => ({
  ...transcriptModel("hermes", {
    status: AsyncData.succeed(statusOf()),
    transcript: AsyncData.succeed(transcriptOf({ session: "1" })),
    threads: AsyncData.succeed({ bot: "hermes", threads: [] }),
    draft: "half a thought",
    pending: [{ text: "sent", after: 1 }],
  }),
  screen: Screen.Transcript({ bot: "hermes" }),
});

/** Hermes's "plan" thread on screen, loaded. */
const onPlan = (overrides: Parameters<typeof transcriptModel>[1] = {}) => ({
  ...transcriptModel("hermes", {
    thread: "plan",
    status: AsyncData.succeed(statusOf()),
    transcript: AsyncData.succeed(transcriptOf({ session: "4" })),
    threads: AsyncData.succeed({ bot: "hermes", threads: [] }),
    ...overrides,
  }),
  screen: Screen.Transcript({ bot: "hermes", thread: "plan" }),
  polling: false,
});

describe("the URL names the conversation", () => {
  test("a thread has a path of its own under its bot, and reads back from it", () => {
    const screen = Screen.Transcript({ bot: "hermes", thread: "a b/c" });

    expect(pathOf(screen)).toBe("/chat/hermes/a%20b%2Fc");
    expect(screenOfPath("/chat/hermes/a%20b%2Fc")).toEqual(screen);
    expect(screenOfPath("/chat/hermes/plan/")).toEqual(
      Screen.Transcript({ bot: "hermes", thread: "plan" }),
    );
  });

  test("a thread segment nobody could have built is the home, not a crash", () => {
    expect(screenOfPath("/chat/hermes/%E0%A4%A")).toEqual(Screen.Home());
    expect(screenOfPath("/chat/hermes/plan/extra")).toEqual(Screen.Home());
  });

  test("a deep link to a thread opens that thread and reads its transcript and the list", () => {
    const { model: initial, commands } = init(urlOf("/chat/hermes/plan"));

    expect(initial.screen).toEqual(Screen.Transcript({ bot: "hermes", thread: "plan" }));
    expect(channelOf(initial, "hermes").thread).toBe("plan");
    expect(
      (commands ?? []).map((command) => `${command.name} ${JSON.stringify(command.args ?? {})}`),
    ).toEqual([
      "Status {}",
      'Transcript {"bot":"hermes","thread":"plan"}',
      'Threads {"bot":"hermes"}',
    ]);
  });
});

describe("moving between conversations", () => {
  test("opening a thread starts its record afresh and keeps the bot's own facts", () => {
    story(
      update,
      given(onMain()),
      message(Message.ClickedOpenThread({ bot: "hermes", thread: "plan" })),
      Command.expectExact(
        Navigate({ path: "/chat/hermes/plan" }),
        Transcript({ bot: "hermes", thread: "plan" }),
      ),
      model((m) => {
        const channel = channelOf(m, "hermes");
        expect(m.screen).toEqual(Screen.Transcript({ bot: "hermes", thread: "plan" }));
        expect(channel.thread).toBe("plan");
        // The main conversation's words, draft and sends do not follow.
        expect(AsyncData.isIdle(channel.transcript)).toBe(true);
        expect(channel.draft).toBe("");
        expect(channel.pending).toEqual([]);
        // The bot's status and its list are the same bot's.
        expect(AsyncData.getData(channel.status)).toEqual(Option.some(statusOf()));
        expect(AsyncData.getData(channel.threads)).toEqual(
          Option.some({ bot: "hermes", threads: [] }),
        );
      }),
      Command.resolve(Navigate({ path: "/chat/hermes/plan" }), Message.Navigated()),
      Command.resolve(
        Transcript({ bot: "hermes", thread: "plan" }),
        Message.TranscriptLoaded({
          bot: "hermes",
          thread: "plan",
          page: transcriptOf({ session: "4", entries: [entryOf({ id: 9, text: "Plan v1" })] }),
        }),
      ),
      model((m) => {
        expect(transcriptIn(m, "hermes").entries.map((entry) => entry.id)).toEqual([9]);
      }),
    );
  });

  test("going back to the main conversation reads its transcript again", () => {
    story(
      update,
      given(onPlan()),
      message(Message.ClickedOpenThread({ bot: "hermes" })),
      Command.expectExact(Navigate({ path: "/chat/hermes" }), Transcript({ bot: "hermes" })),
      model((m) => {
        expect(channelOf(m, "hermes").thread).toBeUndefined();
      }),
      Command.resolve(Navigate({ path: "/chat/hermes" }), Message.Navigated()),
      Command.resolve(
        Transcript({ bot: "hermes" }),
        Message.TranscriptLoaded({ bot: "hermes", page: transcriptOf({ session: "1" }) }),
      ),
    );
  });

  test("a page asked for by the conversation the person left is dropped", () => {
    const { model: after } = foldMessages(onMain(), [
      Message.ClickedOpenThread({ bot: "hermes", thread: "plan" }),
      // The main conversation's poll was already in flight.
      Message.TranscriptLoaded({
        bot: "hermes",
        page: transcriptOf({ session: "1", entries: [entryOf({ id: 3, text: "main" })] }),
      }),
    ]);

    expect(AsyncData.getData(channelOf(after, "hermes").transcript)).toEqual(Option.none());
  });

  test("the home's way into a bot reopens the conversation last open with it", () => {
    story(
      update,
      given({ ...onPlan(), screen: Screen.Home() }),
      message(Message.ClickedOpenTranscript({ bot: "hermes" })),
      Command.expectExact(Navigate({ path: "/chat/hermes/plan" })),
      model((m) => {
        expect(m.screen).toEqual(Screen.Transcript({ bot: "hermes", thread: "plan" }));
        expect(transcriptIn(m, "hermes").session).toBe("4");
      }),
      Command.resolve(Navigate({ path: "/chat/hermes/plan" }), Message.Navigated()),
    );
  });
});

describe("a new conversation", () => {
  test("is minted, then opened at its own URL before the server has heard of it", () => {
    story(
      update,
      given(onMain()),
      message(Message.ClickedNewThread({ bot: "hermes" })),
      Command.expectExact(StartThread({ bot: "hermes" })),
      Command.resolve(
        StartThread({ bot: "hermes" }),
        Message.ThreadStarted({ bot: "hermes", thread: "t-1" }),
      ),
      Command.expectExact(
        Navigate({ path: "/chat/hermes/t-1" }),
        Transcript({ bot: "hermes", thread: "t-1" }),
      ),
      model((m) => {
        expect(channelOf(m, "hermes").thread).toBe("t-1");
      }),
      Command.resolve(Navigate({ path: "/chat/hermes/t-1" }), Message.Navigated()),
      Command.resolve(
        Transcript({ bot: "hermes", thread: "t-1" }),
        Message.TranscriptLoaded({
          bot: "hermes",
          thread: "t-1",
          page: transcriptOf({ session: "t-1", entries: [] }),
        }),
      ),
    );
  });
});

describe("sending in a thread", () => {
  test("the composer sends to the thread on screen, and the send refreshes the list", () => {
    story(
      update,
      given(onPlan({ draft: "Add the budget" })),
      message(Message.SubmittedChat({ bot: "hermes" })),
      Command.expectExact(Chat({ bot: "hermes", text: "Add the budget", thread: "plan" })),
      Command.resolve(
        Chat({ bot: "hermes", text: "Add the budget", thread: "plan" }),
        Message.ChatSent({ bot: "hermes", thread: "plan", operationId: "op-1" }),
      ),
      // The first message of a thread is what creates it on the server, so the
      // list is read again along with the status and the transcript.
      Command.expectExact(
        Status(),
        Transcript({ bot: "hermes", thread: "plan" }),
        Threads({ bot: "hermes" }),
      ),
      Command.resolve(
        Status(),
        Message.StatusLoaded({ bots: { hermes: statusOf() }, errors: {}, at: 1 }),
      ),
      Command.resolve(
        Transcript({ bot: "hermes", thread: "plan" }),
        Message.TranscriptLoaded({
          bot: "hermes",
          thread: "plan",
          page: transcriptOf({ session: "4" }),
        }),
      ),
      Command.resolve(Threads({ bot: "hermes" }), emptyList("hermes")),
    );
  });

  test("a failed send to a conversation the person left does not put its words in this one", () => {
    const { model: after } = foldMessages(onPlan({ draft: "Add the budget" }), [
      Message.SubmittedChat({ bot: "hermes" }),
      Message.ClickedOpenThread({ bot: "hermes" }),
      Message.ChatFailed({ bot: "hermes", thread: "plan", error: "offline" }),
    ]);

    expect(channelOf(after, "hermes").draft).toBe("");
    expect(toastText(after)).toBe("Couldn't reach Hermes (offline).");
  });
});

describe("streams follow the conversation on screen", () => {
  test("a frame from a stream the channel no longer follows is dropped", () => {
    const seeded = onPlan();
    const { model: after } = foldMessages(seeded, [
      Message.FrameReceived({
        ...frameOf({ kind: "append", at: 1, entries: [entryOf({ id: 40, text: "elsewhere" })] }, 5),
        stream: "feed:1:3",
      }),
    ]);

    expect(transcriptIn(after, "hermes").entries.map((entry) => entry.id)).toEqual([1]);
  });

  test("the run of another conversation gives this one no stream to follow", () => {
    const run = {
      ordinal: 1,
      inputs: ["elsewhere"],
      startedAt: 1,
      session: "1",
      stream: { stream: "feed:1:7", generation: 7, cursor: 0, state: "streaming" as const },
    };
    const { model: after } = foldMessages(onPlan(), [
      Message.StatusLoaded({
        bots: { hermes: statusOf({ activeStream: undefined, activeRun: run }) },
        errors: {},
        at: 1,
      }),
    ]);

    expect(channelOf(after, "hermes").stream.generation).toBe(0);
  });

  test("the run of this conversation is the stream it follows", () => {
    const run = {
      ordinal: 1,
      inputs: ["Plan"],
      startedAt: 1,
      session: "4",
      stream: { stream: "feed:4:2", generation: 2, cursor: 0, state: "streaming" as const },
    };
    const { model: after } = foldMessages(onPlan(), [
      Message.StatusLoaded({
        bots: { hermes: statusOf({ activeStream: undefined, activeRun: run }) },
        errors: {},
        at: 1,
      }),
    ]);

    expect(channelOf(after, "hermes").stream.generation).toBe(2);
  });
});

describe("archiving", () => {
  test("asks the server, and only the answer takes the thread out", () => {
    story(
      update,
      given(onPlan()),
      message(Message.ClickedArchiveThread({ bot: "hermes", thread: "plan" })),
      Command.expectExact(ArchiveThread({ bot: "hermes", thread: "plan" })),
      model((m) => {
        expect(m.screen).toEqual(Screen.Transcript({ bot: "hermes", thread: "plan" }));
      }),
      Command.resolve(
        ArchiveThread({ bot: "hermes", thread: "plan" }),
        Message.ArchiveFailed({ bot: "hermes", thread: "plan", error: "offline" }),
      ),
      model((m) => {
        expect(m.screen).toEqual(Screen.Transcript({ bot: "hermes", thread: "plan" }));
      }),
      settleToast(),
    );
  });

  test("an archived thread on screen moves the screen to the main conversation", () => {
    const { model: after, issued } = foldMessages(onPlan(), [
      Message.ThreadArchived({ bot: "hermes", thread: "plan" }),
    ]);

    expect(after.screen).toEqual(Screen.Transcript({ bot: "hermes" }));
    expect(channelOf(after, "hermes").thread).toBeUndefined();
    expect(issued).toEqual(
      expect.arrayContaining([
        'Threads {"bot":"hermes"}',
        'Navigate {"path":"/chat/hermes"}',
        'Transcript {"bot":"hermes"}',
      ]),
    );
    expect(toastText(after)).toBe("Archived the conversation with Hermes.");
  });
});

test("the list arriving lands on the bot's channel", () => {
  const list = {
    bot: "hermes",
    threads: [{ session: "1", archived: false, busy: false, pendingApprovals: 0 }],
  };
  const { model: after } = foldMessages(modelWith(), [
    Message.ThreadsLoaded({ bot: "hermes", threads: list }),
  ]);

  expect(AsyncData.getData(channelOf(after, "hermes").threads)).toEqual(Option.some(list));
});
