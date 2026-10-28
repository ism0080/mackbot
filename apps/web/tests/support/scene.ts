/**
 * Shared setup for the Scene tests in this directory.
 *
 * A Scene starts from a whole Model, and most screens only read two parts of
 * it: the screen being shown and one channel per bot. These helpers build those
 * two parts from the fixtures, so a test states the facts it is about — a
 * bot's status, its transcript — without repeating the empty channel shape or
 * the fleet's "everything answered" roster.
 */
import type { BotView, TranscriptPage } from "@mackbot/contract";
import { AsyncData } from "foldkit";

import type { Channel, Model } from "../../src/model.ts";
import { FIXTURE_NOW, modelWith } from "./fixtures.ts";

/** A channel with nothing asked for and nothing known yet. */
export const idleChannel = (overrides: Partial<Channel> = {}): Channel => ({
  status: AsyncData.Idle(),
  transcript: AsyncData.Idle(),
  stream: { phase: "idle", generation: 0, lastSeq: 0, attempt: 0 },
  frames: [],
  draft: "",
  sending: false,
  refreshing: false,
  pending: [],
  ...overrides,
});

/** A channel whose status and transcript the routes have answered. An absent
 *  one stays idle, which is the state a request that has not landed is in. */
export const botChannel = (
  options: {
    readonly status?: BotView;
    readonly page?: TranscriptPage;
  } & Partial<Omit<Channel, "status" | "transcript">> = {},
): Channel => {
  const { status, page, ...rest } = options;
  return idleChannel({
    ...(status === undefined ? {} : { status: AsyncData.succeed(status) }),
    ...(page === undefined ? {} : { transcript: AsyncData.succeed(page) }),
    ...rest,
  });
};

/**
 * The Model a scene starts from. The roster is in hand and the clock is pinned
 * by default, because both are true of a screen that is being looked at and a
 * test that leaves them out would be asserting the loading notice instead.
 */
export const appModel = (
  screen: Model["screen"],
  channels: Readonly<Record<string, Channel>> = {},
  overrides: Partial<Model> = {},
): Model => ({
  ...modelWith(),
  screen,
  roster: AsyncData.succeed(null),
  now: FIXTURE_NOW,
  channels,
  ...overrides,
});
