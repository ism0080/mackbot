import { Option } from "effect";
import { AsyncData } from "foldkit";
import { Command, given, message, model, story } from "foldkit/story";
import { fromString } from "foldkit/url";
import { describe, expect, test } from "vitest";

import { Catalog, Roster, Transcript } from "../src/api.ts";
import { init } from "../src/main.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { Navigate, OpenLink, pathOf, screenOfPath } from "../src/route.ts";
import { update } from "../src/update.ts";
import { CATALOG, modelWith, rosterOf, transcriptOf } from "./support/fixtures.ts";
import { botChannel, channelOf, dataOf, foldMessages, transcriptIn } from "./support/story.ts";

const at = 1_792_145_100_000;

const urlOf = (pathname: string) =>
  Option.getOrThrow(fromString(`https://mackbot.test${pathname}`));

describe("screenOfPath and pathOf", () => {
  test("pathOf names each screen's route", () => {
    expect(pathOf(Screen.Home())).toBe("/");
    expect(pathOf(Screen.NewChat())).toBe("/new");
    expect(pathOf(Screen.Bots())).toBe("/bots");
    expect(pathOf(Screen.Transcript({ bot: "hermes" }))).toBe("/chat/hermes");
  });

  test("screenOfPath reads each route", () => {
    expect(screenOfPath("/")).toEqual(Screen.Home());
    expect(screenOfPath("/new")).toEqual(Screen.NewChat());
    expect(screenOfPath("/bots")).toEqual(Screen.Bots());
    expect(screenOfPath("/chat/hermes")).toEqual(Screen.Transcript({ bot: "hermes" }));
  });

  test("a trailing slash still names the transcript", () => {
    expect(screenOfPath("/chat/hermes/")).toEqual(Screen.Transcript({ bot: "hermes" }));
  });

  test("an encoded bot id round-trips through the URL", () => {
    const bot = "a b/c";
    const path = pathOf(Screen.Transcript({ bot }));

    expect(path).toBe("/chat/a%20b%2Fc");
    expect(screenOfPath(path)).toEqual(Screen.Transcript({ bot }));
  });

  test("an unknown path is the home, not a crash", () => {
    expect(screenOfPath("/nothing/here")).toEqual(Screen.Home());
    expect(screenOfPath("/chat/")).toEqual(Screen.Home());
  });
});

describe("UrlChanged", () => {
  test("a transcript that has not been loaded asks for it", () => {
    story(
      update,
      given(modelWith()),
      message(Message.UrlChanged({ pathname: "/chat/scribe" })),
      Command.expectExact(Transcript({ bot: "scribe" })),
      model((m) => {
        expect(m.screen).toEqual(Screen.Transcript({ bot: "scribe" }));
      }),
      Command.resolve(
        Transcript({ bot: "scribe" }),
        Message.TranscriptLoaded({ bot: "scribe", page: transcriptOf({ session: "scribe" }) }),
      ),
    );
  });

  test("a transcript already in hand is not fetched again", () => {
    const seeded = {
      ...modelWith(),
      channels: {
        hermes: botChannel("hermes", {
          transcript: AsyncData.succeed(transcriptOf()),
        }),
      },
    };

    story(
      update,
      given(seeded),
      message(Message.UrlChanged({ pathname: "/chat/hermes" })),
      Command.expectNone(),
      model((m) => {
        expect(m.screen).toEqual(Screen.Transcript({ bot: "hermes" }));
      }),
    );
  });

  test("arriving at the roster by URL reads the roster and the catalog", () => {
    // A reload or a shared link to /bots lands here without the click that
    // would otherwise have asked for them.
    story(
      update,
      given(modelWith()),
      message(Message.UrlChanged({ pathname: "/bots" })),
      Command.expectExact(Roster, Catalog),
      model((m) => {
        expect(m.screen).toEqual(Screen.Bots());
      }),
      Command.resolve(Roster, Message.RosterLoaded({ roster: rosterOf() })),
      Command.resolve(Catalog, Message.CatalogLoaded({ catalog: CATALOG })),
      model((m) => {
        expect(Object.keys(dataOf(m.registry).bots)).toEqual(["hermes", "scribe"]);
      }),
    );
  });

  test("a deep link to the roster loads it from the first render", () => {
    const { model: initial, commands } = init(urlOf("/bots"));

    expect(initial.screen).toEqual(Screen.Bots());
    expect((commands ?? []).map((command) => command.name).sort()).toEqual([
      "Catalog",
      "Roster",
      "Status",
    ]);
  });

  test("the URL change a click causes does not fetch the transcript a second time", () => {
    const { model: after, issued } = foldMessages(modelWith(), [
      Message.ClickedOpenTranscript({ bot: "hermes" }),
      // The push is echoed back as a URL change while the page is in flight.
      Message.UrlChanged({ pathname: "/chat/hermes" }),
    ]);

    expect(issued).toEqual(['Navigate {"path":"/chat/hermes"}', 'Transcript {"bot":"hermes"}']);
    expect(after.screen).toEqual(Screen.Transcript({ bot: "hermes" }));
  });

  test("going back to a transcript whose first page is still loading asks once", () => {
    const { issued } = foldMessages(modelWith(), [
      Message.UrlChanged({ pathname: "/chat/hermes" }),
      Message.UrlChanged({ pathname: "/" }),
      Message.UrlChanged({ pathname: "/chat/hermes" }),
    ]);

    expect(issued).toEqual(['Transcript {"bot":"hermes"}']);
  });
});

describe("opening a transcript", () => {
  test("ClickedOpenTranscript navigates and fetches only when the page is missing", () => {
    story(
      update,
      given(modelWith()),
      message(Message.ClickedOpenTranscript({ bot: "hermes" })),
      Command.expectExact(Navigate({ path: "/chat/hermes" }), Transcript({ bot: "hermes" })),
      model((m) => {
        expect(m.screen).toEqual(Screen.Transcript({ bot: "hermes" }));
      }),
      Command.resolve(Navigate({ path: "/chat/hermes" }), Message.Navigated()),
      Command.resolve(
        Transcript({ bot: "hermes" }),
        Message.TranscriptLoaded({ bot: "hermes", page: transcriptOf() }),
      ),
    );
  });

  test("ClickedOpenTranscript already holding the page only navigates", () => {
    const seeded = {
      ...modelWith(),
      channels: {
        hermes: botChannel("hermes", {
          transcript: AsyncData.succeed(transcriptOf()),
        }),
      },
    };

    story(
      update,
      given(seeded),
      message(Message.ClickedOpenTranscript({ bot: "hermes" })),
      Command.expectExact(Navigate({ path: "/chat/hermes" })),
      model((m) => {
        expect(m.screen).toEqual(Screen.Transcript({ bot: "hermes" }));
      }),
      Command.resolve(Navigate({ path: "/chat/hermes" }), Message.Navigated()),
    );
  });

  test("ClickedLoadEarlier asks for the page the cursor names", () => {
    const seeded = {
      ...modelWith(),
      channels: {
        hermes: botChannel("hermes", {
          transcript: AsyncData.succeed(transcriptOf({ nextBefore: 5 })),
        }),
      },
    };

    story(
      update,
      given(seeded),
      message(Message.ClickedLoadEarlier({ bot: "hermes" })),
      Command.expectExact(Transcript({ bot: "hermes", before: 5 })),
      Command.resolve(
        Transcript({ bot: "hermes", before: 5 }),
        Message.TranscriptLoaded({
          bot: "hermes",
          before: 5,
          page: transcriptOf({
            entries: [{ id: 4, kind: "message", role: "user", text: "older" }],
          }),
        }),
      ),
      model((m) => {
        expect(transcriptIn(m, "hermes").entries.map((entry) => entry.id)).toContain(4);
      }),
    );
  });

  test("a second Load earlier while the first is in flight asks for nothing", () => {
    const seeded = {
      ...modelWith(),
      channels: {
        hermes: botChannel("hermes", {
          transcript: AsyncData.succeed(
            transcriptOf({
              entries: [{ id: 5, kind: "message", role: "user", text: "five" }],
              nextBefore: 5,
            }),
          ),
        }),
      },
    };
    const older = Message.TranscriptLoaded({
      bot: "hermes",
      before: 5,
      page: transcriptOf({
        entries: [{ id: 4, kind: "message", role: "user", text: "older" }],
      }),
    });

    const { model: after, issued } = foldMessages(seeded, [
      Message.ClickedLoadEarlier({ bot: "hermes" }),
      Message.ClickedLoadEarlier({ bot: "hermes" }),
      older,
      // Even a page that does arrive twice lands once.
      older,
    ]);

    expect(issued).toEqual(['Transcript {"bot":"hermes","before":5}']);
    expect(transcriptIn(after, "hermes").entries.map((entry) => entry.id)).toEqual([4, 5]);
    expect(channelOf(after, "hermes").loadingEarlier).toBe(false);
  });

  test("ClickedLoadEarlier with no older page does nothing", () => {
    const seeded = {
      ...modelWith(),
      channels: {
        hermes: botChannel("hermes", {
          transcript: AsyncData.succeed(transcriptOf()),
        }),
      },
    };

    story(
      update,
      given(seeded),
      message(Message.ClickedLoadEarlier({ bot: "hermes" })),
      Command.expectNone(),
    );
  });

  test("ClickedLoadEarlier for a bot with no channel does nothing", () => {
    story(
      update,
      given(modelWith()),
      message(Message.ClickedLoadEarlier({ bot: "hermes" })),
      Command.expectNone(),
      model((m) => {
        expect(m.channels.hermes).toBeUndefined();
      }),
    );
  });
});

describe("in-app navigation", () => {
  test("ClickedBack returns home", () => {
    story(
      update,
      given({ ...modelWith(), screen: Screen.Transcript({ bot: "hermes" }) }),
      message(Message.ClickedBack()),
      Command.expectExact(Navigate({ path: "/" })),
      model((m) => {
        expect(m.screen).toEqual(Screen.Home());
      }),
      Command.resolve(Navigate({ path: "/" }), Message.Navigated()),
    );
  });

  test("ClickedNewChat opens the bot picker", () => {
    story(
      update,
      given({ ...modelWith(), screen: Screen.Home() }),
      message(Message.ClickedNewChat()),
      Command.expectExact(Navigate({ path: "/new" })),
      model((m) => {
        expect(m.screen).toEqual(Screen.NewChat());
      }),
      Command.resolve(Navigate({ path: "/new" }), Message.Navigated()),
    );
  });

  test("ClickedOpenBots asks for the roster and the catalog every time", () => {
    story(
      update,
      given(modelWith()),
      message(Message.ClickedOpenBots()),
      Command.expectExact(Navigate({ path: "/bots" }), Roster, Catalog),
      model((m) => {
        expect(m.screen).toEqual(Screen.Bots());
      }),
      Command.resolve(Navigate({ path: "/bots" }), Message.Navigated()),
      Command.resolve(Roster, Message.RosterLoaded({ roster: rosterOf() })),
      Command.resolve(Catalog, Message.CatalogLoaded({ catalog: CATALOG })),
    );
  });

  test("UrlRequested moves the screen, pushes the path and asks for what it shows", () => {
    story(
      update,
      given(modelWith()),
      message(Message.UrlRequested({ pathname: "/chat/scribe" })),
      Command.expectExact(Navigate({ path: "/chat/scribe" }), Transcript({ bot: "scribe" })),
      model((m) => {
        expect(m.screen).toEqual(Screen.Transcript({ bot: "scribe" }));
      }),
      Command.resolve(Navigate({ path: "/chat/scribe" }), Message.Navigated()),
      Command.resolve(
        Transcript({ bot: "scribe" }),
        Message.TranscriptLoaded({ bot: "scribe", page: transcriptOf({ session: "scribe" }) }),
      ),
    );
  });

  test("a link a bot could not have been allowed to write is never opened", () => {
    for (const href of ["javascript:alert(1)", "data:text/html,<script>", "vbscript:msgbox"]) {
      story(
        update,
        given(modelWith()),
        message(Message.ExternalUrlRequested({ href })),
        Command.expectNone(),
      );
    }
  });

  test("ExternalUrlRequested opens the link without changing the screen", () => {
    const seeded = modelWith({ toast: { text: "still here" } });

    story(
      update,
      given(seeded),
      message(Message.ExternalUrlRequested({ href: "https://example.com" })),
      Command.expectExact(OpenLink({ href: "https://example.com" })),
      model((m) => {
        expect(m.screen).toEqual(seeded.screen);
        expect(m.toast).toEqual(seeded.toast);
      }),
      Command.resolve(
        OpenLink({ href: "https://example.com" }),
        Message.LinkOpened({ href: "https://example.com" }),
      ),
    );
  });

  test("LinkOpened acknowledges the new tab without changing the model", () => {
    const seeded = modelWith({ screen: Screen.Transcript({ bot: "hermes" }), now: at });

    story(
      update,
      given(seeded),
      message(Message.LinkOpened({ href: "https://example.com" })),
      Command.expectNone(),
      model((m) => {
        expect(m.screen).toEqual(Screen.Transcript({ bot: "hermes" }));
        expect(m.now).toBe(at);
      }),
    );
  });

  test("Navigated acknowledges the push without changing the model", () => {
    const seeded = modelWith({ screen: Screen.Bots(), now: at });

    story(
      update,
      given(seeded),
      message(Message.Navigated()),
      Command.expectNone(),
      model((m) => {
        expect(m.screen).toEqual(Screen.Bots());
        expect(m.now).toBe(at);
      }),
    );
  });
});
