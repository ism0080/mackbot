/**
 * Scene tests for the conversations bar on a bot's transcript: what it lists,
 * which one it says is open, and what pressing each control asks for.
 */
import { AsyncData } from "foldkit";
import { Command, click, expect, given, role, scene, selector } from "foldkit/scene";
import { test } from "vitest";

import { ArchiveThread, StartThread, Transcript } from "../src/api.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { Navigate } from "../src/route.ts";
import { update } from "../src/update.ts";
import { view } from "../src/view.ts";
import { approvalOf, statusOf, transcriptOf } from "./support/fixtures.ts";
import { appModel, botChannel } from "./support/scene.ts";
import { settleToastScene } from "./support/toast.ts";

const list = {
  bot: "hermes",
  threads: [
    { session: "1", archived: false, busy: false, pendingApprovals: 1 },
    {
      thread: "plan",
      session: "4",
      title: "Plan the week",
      archived: false,
      busy: true,
      pendingApprovals: 0,
    },
    {
      thread: "notes",
      session: "5",
      title: "Meeting notes",
      archived: false,
      busy: false,
      pendingApprovals: 0,
    },
  ],
};

const onThread = (thread: string | undefined, session: string) =>
  appModel(Screen.Transcript({ bot: "hermes", ...(thread === undefined ? {} : { thread }) }), {
    hermes: botChannel({
      ...(thread === undefined ? {} : { thread }),
      status: statusOf({
        approvals: [approvalOf({ session: "1" })],
      }),
      page: transcriptOf({ session }),
      threads: AsyncData.succeed(list),
    }),
  });

test("the bar lists the main conversation first and says which one is open", () => {
  scene(
    { update, view },
    given(onThread("plan", "4")),
    expect(role("navigation", { name: "Conversations with Hermes" })).toExist(),
    expect(selector('.thread-chip[data-thread=""]')).toContainText("Main"),
    expect(selector('.thread-chip[data-thread="plan"]')).toHaveAttr("aria-current", "page"),
    expect(selector('.thread-chip[data-thread="notes"]')).not.toHaveAttr("aria-current", "page"),
    // A conversation's state is said in words, not only in colour.
    expect(selector('.thread-chip[data-thread="plan"]')).toContainText("working"),
    expect(selector('.thread-chip[data-thread=""]')).toContainText("needs you"),
  );
});

test("another conversation's approval is not shown under this one", () => {
  scene(
    { update, view },
    given(onThread("plan", "4")),
    expect(selector('[data-approval="apr_send"]')).toBeAbsent(),
  );
});

test("the conversation that paused shows its approval", () => {
  scene(
    { update, view },
    given(onThread(undefined, "1")),
    expect(selector('[data-approval="apr_send"]')).toExist(),
  );
});

test("pressing another conversation opens it", () => {
  scene(
    { update, view },
    given(onThread("plan", "4")),
    click(selector('.thread-chip[data-thread="notes"]')),
    Command.expectExact(
      Navigate({ path: "/chat/hermes/notes" }),
      Transcript({ bot: "hermes", thread: "notes" }),
    ),
    Command.resolve(Navigate, Message.Navigated()),
    Command.resolve(
      Transcript,
      Message.TranscriptLoaded({
        bot: "hermes",
        thread: "notes",
        page: transcriptOf({ session: "5" }),
      }),
    ),
    expect(selector('.thread-chip[data-thread="notes"]')).toHaveAttr("aria-current", "page"),
  );
});

test("a new conversation is open before the server lists it, and cannot be archived yet", () => {
  scene(
    { update, view },
    given(onThread("t-new", "t-new")),
    expect(selector('.thread-chip[data-thread="t-new"]')).toContainText("New conversation"),
    expect(selector('.thread-chip[data-thread="t-new"]')).toHaveAttr("aria-current", "page"),
    expect(selector("[data-archive]")).toBeAbsent(),
  );
});

test("New conversation asks for a fresh thread id", () => {
  scene(
    { update, view },
    given(onThread(undefined, "1")),
    // The main conversation is never archived.
    expect(selector("[data-archive]")).toBeAbsent(),
    click(selector('[data-open="new-thread"]')),
    Command.expectExact(StartThread({ bot: "hermes" })),
    Command.resolve(StartThread, Message.ThreadStarted({ bot: "hermes", thread: "t-1" })),
    Command.resolve(Navigate, Message.Navigated()),
    Command.resolve(
      Transcript,
      Message.TranscriptLoaded({
        bot: "hermes",
        thread: "t-1",
        page: transcriptOf({ session: "t-1", entries: [] }),
      }),
    ),
    expect(selector('.thread-chip[data-thread="t-1"]')).toHaveAttr("aria-current", "page"),
  );
});

test("Archive names the conversation it puts away and asks the server", () => {
  scene(
    { update, view },
    given(onThread("plan", "4")),
    click(role("button", { name: "Archive Plan the week" })),
    Command.expectExact(ArchiveThread({ bot: "hermes", thread: "plan" })),
    Command.resolve(
      ArchiveThread,
      Message.ArchiveFailed({ bot: "hermes", thread: "plan", error: "offline" }),
    ),
    settleToastScene(),
  );
});
