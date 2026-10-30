/**
 * Scene tests for the bot picker.
 *
 * The screen exists because an idle bot has no row on the triage home, so the
 * contract here is: every bot the client knows is listed, and choosing one
 * opens its transcript.
 */
import {
  Command,
  click,
  expect,
  expectAll,
  given,
  role,
  scene,
  selector,
  all,
} from "foldkit/scene";
import { test } from "vitest";

import { Catalog, Roster, Threads, Transcript } from "../src/api.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { Navigate } from "../src/route.ts";
import { update } from "../src/update.ts";
import { view } from "../src/view.ts";
import { CATALOG, rosterOf, statusOf, transcriptOf } from "./support/fixtures.ts";
import { appModel, botChannel } from "./support/scene.ts";

const picker = (channels: Parameters<typeof appModel>[1] = {}) =>
  appModel(Screen.NewChat(), channels);

test("the picker lists every known bot with its name and model", () => {
  scene(
    { update, view },
    given(
      picker({
        hermes: botChannel({ status: statusOf() }),
        scribe: botChannel({
          status: statusOf({
            busy: false,
            model: { provider: "opencode-go", id: "longcat-2.5-preview-free" },
            thinkingLevel: null,
          }),
        }),
      }),
    ),
    expect(role("heading", { name: "New chat", level: 1 })).toExist(),
    expect(selector(".hdr-sub")).toContainText("2 bots"),
    expectAll(all.selector("[data-bot]")).toHaveCount(2),
    expect(selector('[data-bot="hermes"] .rt')).toHaveText("Hermes"),
    expect(selector('[data-bot="hermes"] .rmeta')).toHaveText("deepseek-v4-pro · high"),
    expect(selector('[data-bot="scribe"] .rt')).toHaveText("Scribe"),
    // A bot with no level names its model alone.
    expect(selector('[data-bot="scribe"] .rmeta')).toHaveText("longcat-2.5-preview-free"),
  );
});

test("choosing a bot whose thread is not loaded asks for it", () => {
  scene(
    { update, view },
    given(
      picker({
        hermes: botChannel({ status: statusOf() }),
      }),
    ),
    click(role("button", { name: "Chat with Hermes" })),
    Command.expectExact(
      Navigate({ path: "/chat/hermes" }),
      Transcript({ bot: "hermes" }),
      Threads({ bot: "hermes" }),
    ),
    Command.resolve(Transcript, Message.TranscriptLoaded({ bot: "hermes", page: transcriptOf() })),
    Command.resolve(
      Threads,
      Message.ThreadsLoaded({ bot: "hermes", threads: { bot: "hermes", threads: [] } }),
    ),
    Command.resolve(Navigate, Message.Navigated()),
    expect(role("heading", { name: "Hermes", level: 1 })).toExist(),
  );
});

test("choosing a bot whose thread is already loaded only navigates", () => {
  scene(
    { update, view },
    given(
      picker({
        hermes: botChannel({ status: statusOf(), page: transcriptOf() }),
      }),
    ),
    click(role("button", { name: "Chat with Hermes" })),
    // The conversation list is read the first time the screen opens.
    Command.expectExact(Navigate({ path: "/chat/hermes" }), Threads({ bot: "hermes" })),
    Command.resolve(
      Threads,
      Message.ThreadsLoaded({ bot: "hermes", threads: { bot: "hermes", threads: [] } }),
    ),
    Command.resolve(Navigate, Message.Navigated()),
    expect(role("heading", { name: "Hermes", level: 1 })).toExist(),
  );
});

test("an empty picker points at the roster", () => {
  scene(
    { update, view },
    given(picker()),
    expect(selector(".empty strong")).toHaveText("No bots yet"),
    click(role("button", { name: "Open Bots" })),
    Command.expectExact(Navigate({ path: "/bots" }), Roster(), Catalog()),
    Command.resolve(Roster, Message.RosterLoaded({ roster: rosterOf() })),
    Command.resolve(Catalog, Message.CatalogLoaded({ catalog: CATALOG })),
    Command.resolve(Navigate, Message.Navigated()),
    expect(role("heading", { name: "Bots", level: 1 })).toExist(),
  );
});

test("the back button returns to the triage home", () => {
  scene(
    { update, view },
    given(picker()),
    click(role("button", { name: "Back to Needs you" })),
    Command.expectExact(Navigate({ path: "/" })),
    Command.resolve(Navigate, Message.Navigated()),
    expect(role("heading", { name: "Nothing needs you", level: 1 })).toExist(),
  );
});
