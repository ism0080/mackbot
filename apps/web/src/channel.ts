/**
 * channel — one bot's record in the Model, and the folds over it that more
 * than one module needs: reading its status and transcript, merging pages, and
 * retiring the messages this client sent once the server has recorded them.
 */
import type { BotView, EntryView, TranscriptPage } from "@mackbot/contract";
import { Option } from "effect";
import { AsyncData } from "foldkit";
import { modifyFields } from "foldkit/struct";

import type { Channel, Model, PendingMessage } from "./model.ts";

export const emptyChannel = (): Channel => ({
  status: AsyncData.Idle(),
  transcript: AsyncData.Idle(),
  stream: { phase: "idle", generation: 0, lastSeq: 0, attempt: 0, failures: 0 },
  frames: [],
  draft: "",
  sending: false,
  refreshing: false,
  loadingEarlier: false,
  pending: [],
});

/** A record read that admits the key it does not have. */
export const lookup = <A>(record: Readonly<Record<string, A>>, key: string): A | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

export const channelOf = (model: Model, bot: string): Channel | undefined =>
  lookup(model.channels, bot);

/** The bot's status, when the route has answered for it. */
export const statusOf = (channel: Channel | undefined): Option.Option<BotView> =>
  channel === undefined ? Option.none() : AsyncData.getData(channel.status);

/** The bot's transcript as far as it has loaded, when it has. */
export const pageOf = (channel: Channel | undefined): Option.Option<TranscriptPage> =>
  channel === undefined ? Option.none() : AsyncData.getData(channel.transcript);

export const withChannel = (
  model: Model,
  bot: string,
  change: (channel: Channel) => Channel,
): Model => ({
  ...model,
  channels: { ...model.channels, [bot]: change(channelOf(model, bot) ?? emptyChannel()) },
});

export const modifyStatus = (channel: Channel, change: (view: BotView) => BotView): Channel =>
  modifyFields(channel, { status: (status) => AsyncData.map(status, change) });

export const mergeEntries = (
  existing: readonly EntryView[],
  incoming: readonly EntryView[],
): readonly EntryView[] => {
  const byId = new Map(existing.map((entry) => [entry.id, entry]));
  for (const entry of incoming) byId.set(entry.id, entry);
  return [...byId.values()].sort((left, right) => left.id - right.id);
};

export const mergeEntriesInto = (
  transcript: AsyncData.AsyncData<TranscriptPage, string>,
  entries: readonly EntryView[],
): AsyncData.AsyncData<TranscriptPage, string> =>
  AsyncData.map(transcript, (page) => ({ ...page, entries: mergeEntries(page.entries, entries) }));

/**
 * A page landing on what is already loaded. Entries merge by id either way, so
 * a page that arrives twice — a doubled request, or a poll overlapping a page
 * of history — never shows an entry twice.
 */
export const mergePage = (
  previous: TranscriptPage | undefined,
  page: TranscriptPage,
  before: number | undefined,
): TranscriptPage => {
  if (previous === undefined) return page;
  const entries = mergeEntries(previous.entries, page.entries);
  // A reload of the newest page keeps the older pages already on screen, and
  // keeps their cursor so "Load earlier" still points past the oldest entry
  // rather than past the newest page's first one. An older page moves only the
  // cursor: the rest of what the newest page said is still the newest word.
  return before === undefined
    ? { ...page, entries, nextBefore: previous.nextBefore }
    : { ...previous, entries, nextBefore: page.nextBefore };
};

/** The newest entry id the client holds, or -1 for a thread it holds none of. */
export const newestEntryIdOf = (channel: Channel): number =>
  Option.match(pageOf(channel), {
    onNone: () => -1,
    onSome: (page) => page.entries.reduce((newest, entry) => Math.max(newest, entry.id), -1),
  });

/**
 * Retire the optimistic messages the transcript has caught up with.
 *
 * Sends are one at a time and the server records them in order, so each
 * pending message is the first user entry with its words past the point the
 * one before it was recorded at. The floor carries forward, which is what keeps
 * a second "yes" pending after the first "yes" has been recorded: the entry
 * that retired the first can never retire the second.
 */
export const confirmedPending = (
  pending: readonly PendingMessage[],
  entries: readonly EntryView[],
): readonly PendingMessage[] => {
  const remaining: PendingMessage[] = [];
  let floor = -1;
  for (const message of pending) {
    const after = Math.max(message.after, floor);
    const recorded = entries.find(
      (entry) => entry.role === "user" && entry.id > after && entry.text === message.text,
    );
    if (recorded === undefined) {
      remaining.push({ ...message, after });
    } else {
      floor = recorded.id;
    }
  }
  return remaining;
};

export const prunePending = (channel: Channel, entries: readonly EntryView[]): Channel =>
  modifyFields(channel, { pending: (pending) => confirmedPending(pending, entries) });
