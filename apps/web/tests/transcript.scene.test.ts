/**
 * Scene tests for one bot's transcript.
 *
 * The screen is opened the way the route opens it — a `Transcript` Screen with
 * that bot's channel already in the Model — and then driven through the
 * rendered view: the composer, the older-page button, the approvals row and
 * the way back.
 */
import {
  Command,
  click,
  expect,
  given,
  role,
  scene,
  selector,
  submit,
  textContent,
  type,
} from "foldkit/scene";
import { expect as viExpect, test } from "vitest";

import { Chat, Status, Transcript } from "../src/api.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { Navigate } from "../src/route.ts";
import { update } from "../src/update.ts";
import { view } from "../src/view.ts";
import { approvalOf, entryOf, FIXTURE_NOW, statusOf, transcriptOf } from "./support/fixtures.ts";
import { appModel, botChannel } from "./support/scene.ts";

const at = (minutesAgo: number): number => FIXTURE_NOW - minutesAgo * 60_000;

const stream = {
  stream: "feed:hermes:3",
  generation: 3,
  cursor: 12,
  state: "streaming" as const,
};

const hermes = (channel: Parameters<typeof botChannel>[0] = {}) =>
  appModel(Screen.Transcript({ bot: "hermes" }), { hermes: botChannel(channel) });

test("a transcript with no entries invites the first message", () => {
  scene(
    { update, view },
    given(
      hermes({
        status: statusOf(),
        page: transcriptOf({ entries: [] }),
      }),
    ),
    expect(role("heading", { name: "Hermes", level: 1 })).toExist(),
    expect(selector(".empty strong")).toHaveText("No messages with Hermes yet"),
    expect(selector(".empty p")).toHaveText("Send the first one below."),
  );
});

test("entries keep their order and say who spoke and from where", () => {
  scene(
    { update, view },
    given(
      hermes({
        status: statusOf(),
        page: transcriptOf({
          entries: [
            entryOf({ id: 1, role: "user", text: "Morning, Hermes.", origin: "http" }),
            entryOf({
              id: 2,
              role: "assistant",
              text: "Three things moved overnight.",
              origin: "http",
            }),
            entryOf({
              id: 3,
              role: "assistant",
              text: "Nightly digest",
              origin: "cron",
              at: at(10),
            }),
          ],
        }),
      }),
    ),
    expect(selector('[data-entry="1"]')).toHaveClass("me"),
    expect(selector('[data-entry="2"]')).toHaveClass("bot"),
    // A cron turn is not something the person asked for, so it says so.
    expect(selector('[data-entry="2"] .origin')).toBeAbsent(),
    expect(selector('[data-entry="3"] .origin')).toContainText("cron"),
    // The page renders in entry order, oldest first.
    (simulation) => {
      const body = textContent(simulation.html);
      viExpect(body.indexOf("Morning, Hermes.")).toBeLessThan(
        body.indexOf("Three things moved overnight."),
      );
      viExpect(body.indexOf("Three things moved overnight.")).toBeLessThan(
        body.indexOf("Nightly digest"),
      );
      return simulation;
    },
  );
});

test("a turn that only called tools leaves no bubble behind", () => {
  scene(
    { update, view },
    given(
      hermes({
        status: statusOf(),
        page: transcriptOf({
          entries: [
            entryOf({ id: 1, role: "user", text: "Check the inbox." }),
            // pi commits this turn as an assistant message whose only content
            // was the tool call, so it projects to no text at all.
            entryOf({ id: 2, role: "assistant", text: "" }),
            entryOf({ id: 3, role: "tool", text: '{"moved":0}', toolName: "gmail.check" }),
            entryOf({ id: 4, role: "assistant", text: "Nothing new arrived." }),
          ],
        }),
      }),
    ),
    expect(selector('[data-entry="2"]')).toBeAbsent(),
    expect(selector('details[data-entry="3"]')).toExist(),
    expect(selector('[data-entry="4"]')).toContainText("Nothing new arrived."),
  );
});

test("a tool result collapses when it worked and opens when it failed", () => {
  scene(
    { update, view },
    given(
      hermes({
        status: statusOf(),
        page: transcriptOf({
          entries: [
            entryOf({
              id: 1,
              role: "tool",
              text: '{"delivered":true}',
              toolName: "botmail.send",
            }),
            entryOf({
              id: 2,
              role: "tool",
              text: "SMTP refused the connection",
              toolName: "botmail.send",
              toolFailed: true,
            }),
          ],
        }),
      }),
    ),
    expect(selector('details[data-entry="1"]')).not.toHaveAttr("open"),
    expect(selector('[data-entry="1"] .tool-name')).toHaveText("botmail.send"),
    expect(selector('[data-entry="1"] .tool-meta')).toHaveText("ok"),
    expect(selector('details[data-entry="2"]')).toHaveAttr("open"),
    expect(selector('[data-entry="2"] .tool-name')).toHaveText("botmail.send"),
    expect(selector('[data-entry="2"] .tool-meta')).toHaveText("failed"),
    expect(selector('[data-entry="2"] .tool-body')).toContainText("SMTP refused"),
  );
});

test("the composer sends the draft and shows it before the server records it", () => {
  const said = "Check the inbox.";

  scene(
    { update, view },
    given(
      hermes({
        status: statusOf(),
        page: transcriptOf({ entries: [] }),
      }),
    ),
    expect(role("button", { name: "Send" })).toBeDisabled(),
    type(role("textbox", { name: "Message Hermes" }), said),
    expect(role("button", { name: "Send" })).toBeEnabled(),
    submit(selector("form.composer")),
    Command.expectExact(Chat({ bot: "hermes", text: said })),
    expect(role("button", { name: "Sending…" })).toBeDisabled(),
    expect(selector("[data-pending]")).toHaveText(said),
    Command.resolve(Chat, Message.ChatSent({ bot: "hermes", operationId: "http:op-1" })),
    // The server admitted it; the reply is still this client's own claim until
    // the transcript carries the recorded entry.
    expect(selector("[data-pending]")).toHaveText(said),
    Command.expectExact(Status(), Transcript({ bot: "hermes" })),
    Command.resolve(
      Status,
      Message.StatusLoaded({ bots: { hermes: statusOf() }, errors: {}, at: FIXTURE_NOW }),
    ),
    Command.resolve(
      Transcript,
      Message.TranscriptLoaded({
        bot: "hermes",
        page: transcriptOf({
          entries: [entryOf({ id: 1, role: "user", text: said, at: FIXTURE_NOW })],
        }),
      }),
    ),
    expect(selector("[data-pending]")).toBeAbsent(),
    expect(selector('[data-entry="1"]')).toContainText(said),
  );
});

test("a send that fails puts the text back and says so", () => {
  const said = "Check the inbox.";

  scene(
    { update, view },
    given(
      hermes({
        status: statusOf(),
        page: transcriptOf({ entries: [] }),
      }),
    ),
    type(role("textbox", { name: "Message Hermes" }), said),
    submit(selector("form.composer")),
    Command.expectExact(Chat({ bot: "hermes", text: said })),
    Command.resolve(Chat, Message.ChatFailed({ bot: "hermes", error: "offline" })),
    expect(selector('[data-field="chat"]')).toHaveValue(said),
    expect(selector("[data-pending]")).toBeAbsent(),
    expect(selector("[data-toast]")).toContainText("Couldn't reach Hermes (offline)."),
    expect(selector("[data-toast]")).toContainText("Your message is still here."),
  );
});

test("Load earlier exists only while the page has an older cursor", () => {
  scene(
    { update, view },
    given(
      hermes({
        status: statusOf(),
        page: transcriptOf({ entries: [entryOf()] }),
      }),
    ),
    expect(role("button", { name: "Load earlier" })).toBeAbsent(),
  );

  scene(
    { update, view },
    given(
      hermes({
        status: statusOf(),
        page: transcriptOf({ entries: [entryOf()], nextBefore: 12 }),
      }),
    ),
    click(role("button", { name: "Load earlier" })),
    Command.expectExact(Transcript({ bot: "hermes", before: 12 })),
    Command.resolve(
      Transcript,
      Message.TranscriptLoaded({
        bot: "hermes",
        page: transcriptOf({ entries: [entryOf({ id: 0, text: "An older note." })] }),
        before: 12,
      }),
    ),
    expect(selector('[data-entry="0"]')).toContainText("An older note."),
    expect(role("button", { name: "Load earlier" })).toBeAbsent(),
  );
});

test("an active run is a line under the conversation", () => {
  scene(
    { update, view },
    given(
      hermes({
        status: statusOf({
          busy: true,
          activeRun: {
            ordinal: 1,
            inputs: ["Draft the weekly update"],
            startedAt: at(6),
            session: "sess_hermes",
            stream,
          },
        }),
        page: transcriptOf(),
      }),
    ),
    expect(selector(".streamline .live")).toContainText("Draft the weekly update"),
    expect(selector(".streamline .live")).toContainText("running 6m"),
  );
});

test("a pending approval on this thread points back to Needs you", () => {
  scene(
    { update, view },
    given(
      hermes({
        status: statusOf({ approvals: [approvalOf()] }),
        page: transcriptOf(),
      }),
    ),
    expect(role("button", { name: /Waiting on you/u })).toExist(),
    click(selector('[data-approval="apr_send"]')),
    Command.expectExact(Navigate({ path: "/" })),
    Command.resolve(Navigate, Message.Navigated()),
    expect(role("heading", { name: "Needs you", level: 1 })).toExist(),
  );
});

test("the back button returns to the triage home", () => {
  scene(
    { update, view },
    given(
      hermes({
        status: statusOf(),
        page: transcriptOf(),
      }),
    ),
    click(role("button", { name: "Back to Needs you" })),
    Command.expectExact(Navigate({ path: "/" })),
    Command.resolve(Navigate, Message.Navigated()),
    expect(role("heading", { name: "Nothing needs you", level: 1 })).toExist(),
  );
});
