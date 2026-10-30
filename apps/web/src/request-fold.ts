/**
 * request-fold — the reads the update asks for, and the gates that keep them
 * from stacking.
 *
 * A request already in flight is not asked for twice: the Model records it,
 * and every place that wants a read goes through here, so a click, the URL
 * change that click causes and a poll that lands in between make one request
 * between them. Each helper is an update step, so a handler composes the reads
 * it needs with `Update.combine`.
 */
import { AsyncData, Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import { Catalog, Roster, Status, Threads, Transcript } from "./api.ts";
import { channelOf, openConversation, threadField, withChannel } from "./channel.ts";
import { dataOf } from "./data.ts";
import type { Message } from "./message.ts";
import { Screen } from "./model.ts";
import type { Model, Screen as ScreenType } from "./model.ts";

type Step = Update.Step<Model, Message>;

/**
 * Ask for `/status`. While one is in flight its answer may predate whatever
 * just changed, so the request is remembered instead and made again the moment
 * that answer lands.
 */
export const requestStatus: Step = (model) =>
  model.polling
    ? { model: modifyFields(model, { statusStale: () => true }) }
    : { model: modifyFields(model, { polling: () => true }), commands: [Status()] };

/** A `/status` answer landed: the gate opens, unless a newer read was owed. */
export const settleStatus: Step = (model) =>
  model.statusStale
    ? {
        model: modifyFields(model, { polling: () => true, statusStale: () => false }),
        commands: [Status()],
      }
    : { model: modifyFields(model, { polling: () => false }) };

/**
 * Ask for the newest transcript page of the conversation the bot's channel
 * shows, unless one is already on its way.
 */
export const requestTranscript =
  (bot: string): Step =>
  (model) => {
    const channel = channelOf(model, bot);
    return channel?.refreshing === true
      ? { model }
      : {
          model: withChannel(model, bot, (current) =>
            modifyFields(current, { refreshing: () => true }),
          ),
          commands: [Transcript({ bot, ...threadField(channel?.thread) })],
        };
  };

/** Ask for the bot's conversation list again: a send or an archive changed it. */
export const requestThreads =
  (bot: string): Step =>
  (model) => ({ model, commands: [Threads({ bot })] });

/** Ask for the bot's conversation list only when nothing has asked for it yet. */
const requestMissingThreads =
  (bot: string): Step =>
  (model) =>
    AsyncData.isIdle(channelOf(model, bot)?.threads ?? AsyncData.Idle())
      ? {
          model: withChannel(model, bot, (channel) =>
            modifyFields(channel, { threads: () => AsyncData.Loading() }),
          ),
          commands: [Threads({ bot })],
        }
      : { model };

/**
 * Point the bot's channel at one of its conversations. The one it already
 * shows is left as it is; any other starts afresh, so its transcript is read
 * from the server rather than shown over the last one's.
 */
const openThread =
  (bot: string, thread: string | undefined): Step =>
  (model) =>
    channelOf(model, bot)?.thread === thread
      ? { model }
      : { model: withChannel(model, bot, (channel) => openConversation(channel, thread)) };

/** Ask for a transcript only when the client holds none of it yet. */
export const requestMissingTranscript =
  (bot: string): Step =>
  (model) => {
    const channel = channelOf(model, bot);
    return channel !== undefined && dataOf(channel.transcript) !== undefined
      ? { model }
      : requestTranscript(bot)(model);
  };

/**
 * What arriving on a screen asks the server for. A transcript the client has
 * not loaded is fetched, and the roster screen reads the roster and the
 * catalog every time it opens so it never edits a stale copy.
 */
export const enterScreen =
  (screen: ScreenType): Step =>
  (model) =>
    Screen.match<Update.Return<Model, Message>>(screen, {
      Home: () => ({ model }),
      NewChat: () => ({ model }),
      Transcript: ({ bot, thread }) =>
        Update.combine(model, [
          openThread(bot, thread),
          requestMissingTranscript(bot),
          requestMissingThreads(bot),
        ]),
      Bots: () => ({ model, commands: [Roster(), Catalog()] }),
    });
