/**
 * Helpers shared by the Story tests.
 *
 * Story drives `update` directly and leaves Commands as data, so the tests read
 * the Model far more often than they act on it. These helpers keep the
 * assertions about a channel's `AsyncData` from every test spelling the tag
 * union by hand, and keep the channel fixture in one place.
 */
import { AsyncData } from "foldkit";

import type { Message } from "../../src/message.ts";
import type { Channel, Model } from "../../src/model.ts";
import { update } from "../../src/update.ts";
import { transcriptModel } from "./fixtures.ts";

/** One bot's channel, failing the test when the update never created it. */
export const channelOf = (model: Model, bot: string): Channel => {
  const channel = model.channels[bot];
  if (channel === undefined) throw new Error(`the model has no channel for "${bot}"`);
  return channel;
};

/**
 * A channel with the app's own defaults, built through the fixture so the
 * defaults stay in `fixtures.ts` rather than being copied here.
 */
export const botChannel = (bot: string, overrides: Partial<Channel> = {}): Channel =>
  channelOf(transcriptModel(bot, overrides), bot);

/** The data an `AsyncData` holds, or a useful failure when it holds none. */
export const dataOf = <A, E>(data: AsyncData.AsyncData<A, E>): A =>
  AsyncData.matchData(data, {
    onEmpty: () => {
      throw new Error("expected AsyncData data, but it is Idle or Loading");
    },
    onFailure: (error) => {
      throw new Error(`expected AsyncData data, but it failed: ${String(error)}`);
    },
    onData: (value) => value,
  });

/** The error an `AsyncData` holds, or a useful failure when it holds none. */
export const errorOf = <A, E>(data: AsyncData.AsyncData<A, E>): E =>
  AsyncData.matchData(data, {
    onEmpty: () => {
      throw new Error("expected an AsyncData error, but it is Idle or Loading");
    },
    onFailure: (error) => error,
    onData: () => {
      throw new Error("expected an AsyncData error, but it holds data");
    },
  });

export const statusIn = (model: Model, bot: string) => dataOf(channelOf(model, bot).status);

export const statusErrorIn = (model: Model, bot: string) => errorOf(channelOf(model, bot).status);

export const transcriptErrorIn = (model: Model, bot: string) =>
  errorOf(channelOf(model, bot).transcript);

export const transcriptIn = (model: Model, bot: string) => dataOf(channelOf(model, bot).transcript);

/** The ids of a transcript's entries, oldest first. */
export const entryIds = (model: Model, bot: string): readonly number[] =>
  transcriptIn(model, bot).entries.map((entry) => entry.id);

/**
 * Messages applied straight through `update`, with every Command they asked
 * for. A Story will not send a Message while a Command is unresolved, so the
 * races that matter here — a click and the URL change it causes, a double
 * press while the first request is in flight — are driven this way instead.
 */
export const foldMessages = (
  start: Model,
  messages: readonly Message[],
): Readonly<{ model: Model; issued: readonly string[] }> =>
  messages.reduce<{ model: Model; issued: readonly string[] }>(
    (state, next) => {
      const result = update(state.model, next);
      return {
        model: result.model,
        issued: [
          ...state.issued,
          ...(result.commands ?? []).map((command) =>
            command.args === undefined
              ? command.name
              : `${command.name} ${JSON.stringify(command.args)}`,
          ),
        ],
      };
    },
    { model: start, issued: [] },
  );
