/**
 * The archive screen: where a bot's archived conversations are listed, and
 * where one is restored to the bot's list.
 */
import { Option } from "effect";
import { AsyncData } from "foldkit";
import { Command, click, expect, given, role, scene, selector } from "foldkit/scene";
import { fromString } from "foldkit/url";
import { describe, expect as expectValue, test } from "vitest";

import { ArchivedThreads, RestoreThread } from "../src/api.ts";
import { init } from "../src/main.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { Navigate, pathOf, screenOfPath } from "../src/route.ts";
import { update } from "../src/update.ts";
import { view } from "../src/view.ts";
import { FIXTURE_NOW, statusOf, transcriptOf } from "./support/fixtures.ts";
import { appModel, botChannel } from "./support/scene.ts";
import { channelOf, foldMessages } from "./support/story.ts";
import { settleToastScene, toastText } from "./support/toast.ts";

/** What `?include=archived` answers: the live conversations and the archived ones. */
const everything = {
  bot: "hermes",
  threads: [
    { session: "1", archived: false, busy: false, pendingApprovals: 0 },
    {
      thread: "plan",
      session: "4",
      title: "Plan the week",
      archived: false,
      busy: false,
      pendingApprovals: 0,
    },
    {
      thread: "trip",
      session: "6",
      title: "Book the trip",
      lastActivityAt: FIXTURE_NOW - 3 * 60 * 60_000,
      archived: true,
      busy: false,
      pendingApprovals: 0,
    },
  ],
};

const onArchive = (archived: ReturnType<typeof botChannel>["archived"]) =>
  appModel(Screen.Archive({ bot: "hermes" }), {
    hermes: botChannel({ status: statusOf(), archived }),
  });

describe("the URL names the archive", () => {
  test("a bot's archive has a path of its own, and reads back from it", () => {
    const screen = Screen.Archive({ bot: "hermes" });

    expectValue(pathOf(screen)).toBe("/archive/hermes");
    expectValue(screenOfPath("/archive/hermes/")).toEqual(screen);
    expectValue(screenOfPath("/archive/%E0%A4%A")).toEqual(Screen.Home());
  });

  test("a deep link to the archive reads the archived conversations", () => {
    const url = Option.getOrThrow(fromString("https://mackbot.test/archive/hermes"));
    const { commands } = init(url);

    expectValue((commands ?? []).map((command) => command.name)).toEqual([
      "Status",
      "ArchivedThreads",
    ]);
  });
});

test("the conversation bar opens the bot's archive", () => {
  scene(
    { update, view },
    given(
      appModel(Screen.Transcript({ bot: "hermes" }), {
        hermes: botChannel({
          status: statusOf(),
          page: transcriptOf({ session: "1" }),
          threads: AsyncData.succeed({ bot: "hermes", threads: [] }),
        }),
      }),
    ),
    click(role("button", { name: "Archived conversations with Hermes" })),
    Command.expectExact(Navigate({ path: "/archive/hermes" }), ArchivedThreads({ bot: "hermes" })),
    Command.resolve(Navigate, Message.Navigated()),
    Command.resolve(
      ArchivedThreads,
      Message.ArchivedThreadsLoaded({ bot: "hermes", threads: everything }),
    ),
    expect(role("heading", { name: "Archived" })).toExist(),
  );
});

test("only the archived conversations are listed, each with a way to restore it", () => {
  scene(
    { update, view },
    given(onArchive(AsyncData.succeed(everything))),
    expect(selector('[data-thread="trip"]')).toContainText("Book the trip"),
    expect(selector('[data-thread="trip"]')).toContainText("last active 3h ago"),
    expect(selector('[data-thread="plan"]')).toBeAbsent(),
    expect(selector('[data-thread=""]')).toBeAbsent(),
    expect(role("button", { name: "Restore Book the trip" })).toExist(),
  );
});

test("an archive with nothing in it says so", () => {
  scene(
    { update, view },
    given(onArchive(AsyncData.succeed({ bot: "hermes", threads: everything.threads.slice(0, 2) }))),
    expect(selector(".empty")).toContainText("No archived conversations with Hermes"),
  );
});

test("an archive that could not be read says why", () => {
  scene(
    { update, view },
    given(onArchive(AsyncData.fail("offline"))),
    expect(selector(".empty")).toContainText("Couldn't read the archived conversations (offline)."),
  );
});

test("Restore asks the server, and the conversation stays listed when it fails", () => {
  scene(
    { update, view },
    given(onArchive(AsyncData.succeed(everything))),
    click(role("button", { name: "Restore Book the trip" })),
    Command.expectExact(RestoreThread({ bot: "hermes", thread: "trip" })),
    Command.resolve(
      RestoreThread,
      Message.RestoreFailed({ bot: "hermes", thread: "trip", error: "offline" }),
    ),
    settleToastScene(),
    expect(selector('[data-thread="trip"]')).toExist(),
  );
});

test("a restored conversation is read back into both of the bot's lists", () => {
  const { model: after, issued } = foldMessages(onArchive(AsyncData.succeed(everything)), [
    Message.ThreadRestored({ bot: "hermes", thread: "trip" }),
  ]);

  expectValue(issued).toEqual(
    expectValue.arrayContaining(['ArchivedThreads {"bot":"hermes"}', 'Threads {"bot":"hermes"}']),
  );
  // The list on screen stays while the new one is on its way.
  expectValue(AsyncData.getData(channelOf(after, "hermes").archived)).toEqual(
    Option.some(everything),
  );
  expectValue(toastText(after)).toBe("Restored the conversation with Hermes.");
});
