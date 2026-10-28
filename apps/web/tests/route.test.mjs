/*
 * The URL mapping, without a render: every screen has one path and every path
 * comes back as the same screen. This is what makes a reload a restore rather
 * than a reset.
 */
import assert from "node:assert/strict";

import { Screen } from "../src/model.ts";
import { pathOf, screenOfPath } from "../src/route.ts";

const run = (label, check) => {
  try {
    check();
  } catch (cause) {
    console.error(`FAIL ${label}\n${cause?.stack ?? cause}`);
    process.exitCode = 1;
    return;
  }
  console.log(`ok   ${label}`);
};

run("the home is the root", () => {
  assert.equal(pathOf(Screen.Home()), "/");
  assert.equal(screenOfPath("/")._tag, "Home");
});

run("a transcript path round-trips its bot id", () => {
  const screen = Screen.Transcript({ bot: "scribe" });
  assert.equal(pathOf(screen), "/chat/scribe");
  const parsed = screenOfPath("/chat/scribe");
  assert.equal(parsed._tag, "Transcript");
  assert.equal(parsed.bot, "scribe");
});

run("a bot id with a reserved character is encoded in the path and decoded back", () => {
  const screen = Screen.Transcript({ bot: "a/b c" });
  assert.equal(pathOf(screen), "/chat/a%2Fb%20c");
  const parsed = screenOfPath(pathOf(screen));
  assert.equal(parsed._tag, "Transcript");
  assert.equal(parsed.bot, "a/b c");
});

run("the picker and the roster keep their own paths", () => {
  assert.equal(pathOf(Screen.NewChat()), "/new");
  assert.equal(pathOf(Screen.Bots()), "/bots");
  assert.equal(screenOfPath("/new")._tag, "NewChat");
  assert.equal(screenOfPath("/bots")._tag, "Bots");
});

run("an unknown path is the home", () => {
  assert.equal(screenOfPath("/does-not-exist")._tag, "Home");
  assert.equal(screenOfPath("/chat/%E0%A4%A")._tag, "Home");
});
