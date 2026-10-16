import type { ApprovalView, BotView, TranscriptPage } from "@mackbot/web-contract";
import { Option } from "effect";
import { AsyncData } from "foldkit";
import { modifyFields } from "foldkit/struct";
import type { Update } from "foldkit";

import { Status, Transcript } from "./api.ts";
import { Message } from "./message.ts";
import { Screen } from "./model.ts";
import type { Channel, Model } from "./model.ts";

const emptyChannel = (): Channel => ({
  status: AsyncData.Idle(),
  transcript: AsyncData.Idle(),
});

/** A record read that admits the key it does not have. */
const lookup = <A>(record: Readonly<Record<string, A>>, key: string): A | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const channelOf = (model: Model, bot: string): Channel | undefined => lookup(model.channels, bot);

const transcriptOf = (model: Model, bot: string): AsyncData.AsyncData<TranscriptPage, string> =>
  channelOf(model, bot)?.transcript ?? AsyncData.Idle();

const dataOf = <A, E>(data: AsyncData.AsyncData<A, E>): A | undefined =>
  Option.match(AsyncData.getData(data), {
    onNone: () => undefined,
    onSome: (value) => value,
  });

const withChannel = (model: Model, bot: string, change: (channel: Channel) => Channel): Model => ({
  ...model,
  channels: { ...model.channels, [bot]: change(channelOf(model, bot) ?? emptyChannel()) },
});

/** Older page first: its entries all precede the ones already loaded. */
const mergePage = (
  previous: TranscriptPage | undefined,
  page: TranscriptPage,
  before: number | undefined,
): TranscriptPage =>
  previous === undefined || before === undefined
    ? page
    : { ...page, entries: [...page.entries, ...previous.entries] };

const decideOne = (approval: ApprovalView, action: "allow" | "deny", at: number): ApprovalView =>
  modifyFields(approval, {
    status: () => (action === "allow" ? "allowed" : "denied"),
    decidedAt: () => at,
  });

const decideInStatus = (
  status: BotView,
  approvalId: string,
  action: "allow" | "deny",
  at: number,
): BotView =>
  modifyFields(status, {
    approvals: (approvals) =>
      approvals.map((approval) =>
        approval.approvalId === approvalId ? decideOne(approval, action, at) : approval,
      ),
  });

/**
 * The one writer of an approval's state. Nothing else removes an approval from
 * a view: the home's blocked list and the transcript's waiting row are both
 * folds over `status.approvals`, so this single write retires the approval
 * everywhere it is shown.
 */
const decideInChannel = (
  channel: Channel,
  approvalId: string,
  action: "allow" | "deny",
  at: number,
): Channel =>
  modifyFields(channel, {
    status: (status) =>
      AsyncData.map(status, (view) => decideInStatus(view, approvalId, action, at)),
  });

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    PolledStatus: () =>
      model.polling
        ? { model }
        : { model: { ...model, polling: true }, commands: [Status()] },
    ClickedBack: () => ({
      model: modifyFields(model, { screen: () => Screen.Home() }),
    }),
    ClickedOpenTranscript: ({ bot }) => ({
      model: modifyFields(model, { screen: () => Screen.Transcript({ bot }) }),
      // Opening a transcript the home could not load is the retry.
      commands: dataOf(transcriptOf(model, bot)) === undefined ? [Transcript({ bot })] : [],
    }),
    ClickedLoadEarlier: ({ bot }) => {
      const page = dataOf(transcriptOf(model, bot));
      return page?.nextBefore === undefined
        ? { model }
        : { model, commands: [Transcript({ bot, before: page.nextBefore })] };
    },
    DecidedApproval: ({ bot, approvalId, action }) => {
      if (channelOf(model, bot) === undefined) return { model };

      return {
        model: withChannel(model, bot, (channel) =>
          decideInChannel(channel, approvalId, action, model.now),
        ),
      };
    },
    StatusLoaded: ({ bots, errors, at }) => {
      const ids = [...new Set([...Object.keys(bots), ...Object.keys(errors)])];
      const channels: Record<string, Channel> = { ...model.channels };
      for (const id of ids) {
        const current = lookup(channels, id) ?? emptyChannel();
        const view = lookup(bots, id);
        channels[id] = {
          ...current,
          status:
            view === undefined
              ? AsyncData.fail(lookup(errors, id) ?? "status unavailable")
              : AsyncData.succeed(view),
        };
      }
      const commands = Object.keys(bots)
        .filter((id) => dataOf(transcriptOf(model, id)) === undefined)
        .map((id) => Transcript({ bot: id }));

      return { model: { ...model, roster: AsyncData.succeed(null), now: at, channels, polling: false }, commands };
    },
    StatusFailed: ({ error, at }) => ({
      model: { ...model, roster: AsyncData.fail(error), now: at, polling: false },
    }),
    TranscriptLoaded: ({ bot, page, before }) => {
      const previous = dataOf(transcriptOf(model, bot));
      return {
        model: withChannel(model, bot, (channel) => ({
          ...channel,
          transcript: AsyncData.succeed(mergePage(previous, page, before)),
        })),
      };
    },
    TranscriptFailed: ({ bot, error }) =>
      // A failed page keeps the entries already rendered; only a first load,
      // which has nothing to keep, becomes the channel's error.
      dataOf(transcriptOf(model, bot)) === undefined
        ? {
            model: withChannel(model, bot, (channel) => ({
              ...channel,
              transcript: AsyncData.fail(error),
            })),
          }
        : { model },
  });
