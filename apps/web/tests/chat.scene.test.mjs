/*
 * Starting a chat and sending a message through the rendered view.
 *
 * Scene enters through the same view the browser renders and finds controls by
 * role and accessible name, so these tests fail if a control loses its label or
 * its handler. Effects never run: the chat Command is resolved with the
 * receipt the Worker would send, then the transcript with the entry it recorded.
 */
import { Chat, Status, Transcript } from "../src/api.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { Navigate } from "../src/route.ts";
import { update } from "../src/update.ts";
import { view } from "../src/view.ts";
import {
  Command as SceneCommand,
  all,
  click,
  expect,
  expectAll,
  given,
  label,
  role,
  scene,
  selector,
  text,
  type,
} from "foldkit/scene";
import { AsyncData } from "foldkit";

import { modelWith, pageWithUser, statusLoaded } from "./support/model.mjs";

/** The URL push every in-app navigation emits; Scene runs no Effects, so the
 *  test acknowledges it with the Message its Effect would produce. */
const navigated = SceneCommand.resolve(Navigate, Message.Navigated());

scene(
  { update, view },
  given(modelWith()),

  // 0 — an idle bot's finished thread is reachable straight from the home, so
  // leaving a thread does not hide it behind a triage section.
  expectAll(all.role("button", { name: /Open chat with/u })).toHaveCount(2),
  expect(role("button", { name: "Open chat with Scribe" })).toExist(),
  click(role("button", { name: "Open chat with Scribe" })),
  navigated,
  expect(role("heading", { name: "Scribe" })).toExist(),
  click(role("button", { name: "Back to Needs you" })),
  navigated,

  // 1 — the picker is a real destination, and every bot is a labelled button.
  click(role("button", { name: "New chat" })),
  navigated,
  expect(role("heading", { name: "New chat" })).toExist(),
  expectAll(all.role("button", { name: /Chat with/u })).toHaveCount(2),
  expect(role("button", { name: "Chat with Scribe" })).toExist(),

  // 2 — a pick opens that bot's transcript with an empty, disabled composer.
  click(role("button", { name: "Chat with Scribe" })),
  navigated,
  expect(role("heading", { name: "Scribe" })).toExist(),
  expect(role("textbox", { name: "Message Scribe" })).toExist(),
  expect(role("button", { name: "Send", disabled: true })).toExist(),

  // 3 — typing enables send, and sending asks the chat route for a receipt.
  type(label("Message Scribe"), "Write the minutes"),
  expect(role("button", { name: "Send", disabled: false })).toExist(),
  click(role("button", { name: "Send" })),
  SceneCommand.expectExact(Chat({ bot: "scribe", text: "Write the minutes" })),
  expect(selector(".msg.pending")).toHaveText("Write the minutes"),
  expect(role("textbox", { name: "Message Scribe" })).toHaveValue(""),

  // 4 — the receipt clears the bubble once the transcript carries the entry.
  SceneCommand.resolveAllExact(
    [Chat, Message.ChatSent({ bot: "scribe", operationId: "op_1" })],
    [Status, Message.StatusLoaded(statusLoaded)],
    [
      Transcript({ bot: "scribe" }),
      Message.TranscriptLoaded({
        bot: "scribe",
        page: pageWithUser("Write the minutes"),
        before: undefined,
      }),
    ],
  ),
  expect(selector(".msg.pending")).toBeAbsent(),
  expect(text("Write the minutes")).toExist(),
);

console.log("ok   new chat picker, composer, optimistic send, and confirmation");

const toolModel = (toolFailed) => {
  const base = modelWith({ screen: Screen.Transcript({ bot: "scribe" }) });
  const page = base.channels.scribe.transcript.data;
  const entry = {
    id: 200,
    kind: "pi.tool-result",
    role: "tool",
    text: '{"status":"completed","execution":{"ok":true}}',
    at: 1,
    toolName: "iCloud Calendar.list_events",
    toolFailed,
  };
  return {
    ...base,
    channels: {
      ...base.channels,
      scribe: {
        ...base.channels.scribe,
        transcript: AsyncData.succeed({ ...page, entries: [entry] }),
      },
    },
  };
};

scene(
  { update, view },
  given(toolModel(false)),
  expect(selector("details.tool")).toExist(),
  expect(text("iCloud Calendar.list_events")).toExist(),
  expect(selector("details.tool")).not.toHaveAttr("open"),
);

scene(
  { update, view },
  given(toolModel(true)),
  expect(selector("details.tool")).toExist(),
  expect(selector("details.tool")).toHaveAttr("open"),
  expect(text("failed")).toExist(),
);

console.log("ok   tool results collapse, and a failed one starts open");
