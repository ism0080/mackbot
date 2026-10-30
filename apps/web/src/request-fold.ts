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
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import { Catalog, Roster, Status, Transcript } from "./api.ts";
import { channelOf, withChannel } from "./channel.ts";
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

/** Ask for a bot's newest transcript page, unless one is already on its way. */
export const requestTranscript =
  (bot: string): Step =>
  (model) =>
    channelOf(model, bot)?.refreshing === true
      ? { model }
      : {
          model: withChannel(model, bot, (channel) =>
            modifyFields(channel, { refreshing: () => true }),
          ),
          commands: [Transcript({ bot })],
        };

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
      Transcript: ({ bot }) => requestMissingTranscript(bot)(model),
      Bots: () => ({ model, commands: [Roster(), Catalog()] }),
    });
