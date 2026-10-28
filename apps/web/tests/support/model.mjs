/*
 * The Model the folding tests start from: two bots whose status and transcript
 * are already in hand, so a Story or Scene test never has to fake a fetch.
 *
 * It is built from the app's own `init`, so a field added to the Model lands
 * here too rather than being forgotten by a hand-written copy.
 */
import { AsyncData } from "foldkit";

import { init } from "../../src/main.ts";
import { Screen } from "../../src/model.ts";
import {
  FIXTURE_NOW,
  HERMES_STATUS,
  SCRIBE_STATUS,
  STATUS_RESPONSE,
  TRANSCRIPTS,
} from "../fixture.mjs";

const channelOf = (bot) => ({
  status: AsyncData.succeed(bot === "scribe" ? SCRIBE_STATUS : HERMES_STATUS),
  transcript: AsyncData.succeed(TRANSCRIPTS[bot]),
  stream: { phase: "closed", generation: 1, lastSeq: 0, attempt: 0 },
  frames: [],
  draft: "",
  sending: false,
  refreshing: false,
  pending: [],
});

/** A complete Model, with the named overrides applied last. */
export const modelWith = (overrides = {}) => ({
  ...init().model,
  polling: false,
  now: FIXTURE_NOW,
  roster: AsyncData.succeed(null),
  screen: Screen.Home(),
  channels: { hermes: channelOf("hermes"), scribe: channelOf("scribe") },
  ...overrides,
});

/** Scribe's transcript with one more message from the user at its tail. */
export const pageWithUser = (text) => {
  const page = TRANSCRIPTS.scribe;
  const highest = Math.max(...page.entries.map((entry) => entry.id));
  return {
    ...page,
    entries: [
      ...page.entries,
      { id: highest + 1, kind: "user", role: "user", text, at: FIXTURE_NOW, origin: "http" },
    ],
  };
};

/** The status answer the app folds after a send. */
export const statusLoaded = { bots: STATUS_RESPONSE.bots, errors: {}, at: FIXTURE_NOW };
