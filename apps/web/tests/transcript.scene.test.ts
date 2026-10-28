/**
 * Scene tests for one bot's transcript.
 *
 * The screen is opened the way the route opens it — a `Transcript` Screen with
 * that bot's channel already in the Model — and then driven through the
 * rendered view: the composer, the older-page button, the approvals row and
 * the way back.
 */
import {
  all,
  Command,
  click,
  expect,
  expectAll,
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
import { CopyMessage } from "../src/clipboard.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { Navigate } from "../src/route.ts";
import { update } from "../src/update.ts";
import { view } from "../src/view.ts";
import { approvalOf, entryOf, FIXTURE_NOW, statusOf, transcriptOf } from "./support/fixtures.ts";
import { appModel, botChannel } from "./support/scene.ts";
import { settleToastScene } from "./support/toast.ts";

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
    expect(selector('[data-entry="3"]')).toExist(),
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
    expect(selector('[data-entry="1"] .tool-summary')).toHaveAttr("aria-expanded", "false"),
    expect(selector('[data-entry="1"] .tool-name')).toHaveText("botmail.send"),
    expect(selector('[data-entry="1"] .tool-meta')).toHaveText("ok"),
    expect(selector('[data-entry="2"] .tool-summary')).toHaveAttr("aria-expanded", "true"),
    expect(selector('[data-entry="2"] .tool-name')).toHaveText("botmail.send"),
    expect(selector('[data-entry="2"] .tool-meta')).toHaveText("failed"),
    expect(selector('[data-entry="2"] .tool-body')).toContainText("SMTP refused"),
    // The failed result opens by default and is still the person's to close:
    // the open state is the Model's, so the default cannot trap them shut.
    click(selector('[data-entry="2"] .tool-summary')),
    expect(selector('[data-entry="2"] .tool-summary')).toHaveAttr("aria-expanded", "false"),
    click(selector('[data-entry="1"] .tool-summary')),
    expect(selector('[data-entry="1"] .tool-summary')).toHaveAttr("aria-expanded", "true"),
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
    settleToastScene(),
    // An answer that failed interrupts: the stack gives it `role="alert"`, so a
    // screen reader reads it without the person having to be looking.
    expect(role("alert")).toExist(),
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

test("copying a reply takes the words as the bot wrote them", () => {
  const reply = "**Nothing changed.** The 09:00 meeting still stands.";

  scene(
    { update, view },
    given(
      hermes({
        status: statusOf(),
        page: transcriptOf({
          entries: [entryOf({ id: 1, role: "assistant", text: reply, origin: "cron", at: at(5) })],
        }),
      }),
    ),
    // The chip says where it came from, and the button is named for a
    // screen reader rather than by its visible word.
    expect(selector('[data-entry="1"] .origin')).toContainText("cron"),
    click(role("button", { name: "Copy message" })),
    // Markdown is copied as written, so it pastes into an editor intact.
    Command.expectExact(CopyMessage({ text: reply })),
    Command.resolve(CopyMessage, Message.CopiedMessage()),
    settleToastScene(),
    expect(selector("[data-toast]")).toContainText("Copied to clipboard."),
    // An answer that only informs is a status, not an interruption.
    expect(role("status")).toExist(),
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

test("a bot's markdown becomes blocks a person can scan", () => {
  scene(
    { update, view },
    given(
      hermes({
        status: statusOf(),
        page: transcriptOf({
          entries: [
            entryOf({
              id: 1,
              role: "assistant",
              // The shape the hourly check-in actually uses: a bold label, a
              // bulleted list, then a numbered list of what it wants.
              text: [
                "**Nothing new arrived.**",
                "",
                "- Hark inbox is clear",
                "- One thread still open from 12 Oct",
                "",
                "**Needs you**",
                "",
                "1. Approve the draft reply",
                "2. Name the bot",
              ].join("\n"),
            }),
          ],
        }),
      }),
    ),
    // The emphasis device the bot writes in lands as emphasis, not asterisks.
    expectAll(all.selector('[data-entry="1"] strong')).toHaveCount(2),
    expect(selector('[data-entry="1"] .md')).not.toContainText("**"),
    // The list is a list: each item its own row, in order.
    expectAll(all.selector('[data-entry="1"] ul li')).toHaveCount(2),
    expectAll(all.selector('[data-entry="1"] ol li')).toHaveCount(2),
    expect(selector('[data-entry="1"] ol li')).toHaveText("Approve the draft reply"),
  );
});

test("a check-in longer than a screen folds its tail instead of dumping it", () => {
  const paragraphs = Array.from({ length: 9 }, (_, index) => `Point ${index + 1} moved.`);

  scene(
    { update, view },
    given(
      hermes({
        status: statusOf(),
        page: transcriptOf({
          entries: [
            entryOf({ id: 1, role: "assistant", text: paragraphs.join("\n\n") }),
            entryOf({ id: 2, role: "assistant", text: "Nothing changed." }),
          ],
        }),
      }),
    ),
    // Nine blocks: six stay, the last three fold behind the toggle.
    expect(selector('[data-entry="1"] .md-clip')).toExist(),
    expect(selector('[data-entry="1"] .md-clip-toggle')).toContainText("3 more"),
    expect(selector('[data-entry="1"] .md-clip-toggle')).toHaveAttr("aria-expanded", "false"),
    // A message that fits already is not given a disclosure at all.
    expect(selector('[data-entry="2"] .md-clip')).toBeAbsent(),
  );
});

test("a link the bot wants approved is a row, not a word in a sentence", () => {
  scene(
    { update, view },
    given(
      hermes({
        status: statusOf(),
        page: transcriptOf({
          entries: [
            entryOf({
              id: 1,
              role: "assistant",
              text: "https://botmail.pro/approve/abc123",
            }),
          ],
        }),
      }),
    ),
    expect(selector('[data-entry="1"] .md-link-row a')).toHaveAttr(
      "href",
      "https://botmail.pro/approve/abc123",
    ),
    expect(selector('[data-entry="1"] .md-link-row a')).toContainText("botmail.pro"),
  );
});
