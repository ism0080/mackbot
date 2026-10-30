/**
 * channel — one bot's record in the Model, and the folds over it that more
 * than one module needs: reading its status and transcript, merging pages, and
 * retiring the messages this client sent once the server has recorded them.
 */
import type {
  ActiveRunView,
  ApprovalView,
  BotView,
  EntryView,
  StreamStatusView,
  ThreadView,
  TranscriptPage,
} from "@mackbot/contract";
import { Option } from "effect";
import { AsyncData } from "foldkit";
import { modifyFields } from "foldkit/struct";

import type { Channel, Model, PendingMessage } from "./model.ts";

export const emptyChannel = (): Channel => ({
  status: AsyncData.Idle(),
  threads: AsyncData.Idle(),
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

/**
 * The `thread` field of a message, a command or a screen: present for a
 * thread, absent for the main conversation rather than set to `undefined`, so
 * two values for the same conversation are equal however they were built.
 */
export const threadField = (thread: string | undefined): { readonly thread?: string } =>
  thread === undefined ? {} : { thread };

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

/**
 * The channel moved onto another conversation. Everything about the one it
 * showed goes — its entries, its stream cursor, the draft and the messages in
 * flight — and the bot's own facts stay: its status and its conversation list.
 */
export const openConversation = (channel: Channel, thread: string | undefined): Channel => ({
  ...emptyChannel(),
  status: channel.status,
  threads: channel.threads,
  ...(thread === undefined ? {} : { thread }),
});

/**
 * The pi session of the conversation the channel shows, once its transcript
 * has said which one it is. The status names runs and approvals by session,
 * so this is what decides whether one of them belongs on this screen.
 */
export const sessionOf = (channel: Channel | undefined): string | undefined =>
  Option.getOrUndefined(Option.map(pageOf(channel), (page) => page.session));

/**
 * Whether a run or an approval for `session` belongs to the conversation the
 * channel shows. One recorded without a session predates threads, so it
 * belongs to the main conversation. Before the transcript names the session,
 * only the main conversation can claim anything, because that is the only one
 * a status written before threads could have meant.
 */
const belongsHere = (channel: Channel, session: string | undefined): boolean => {
  if (session === undefined) return channel.thread === undefined;
  const shown = sessionOf(channel);
  return shown === undefined ? channel.thread === undefined : shown === session;
};

/** The run in flight, when it is this conversation's. */
export const conversationRunOf = (channel: Channel | undefined): ActiveRunView | undefined => {
  if (channel === undefined) return undefined;
  const run = Option.getOrUndefined(statusOf(channel))?.activeRun;
  return run !== undefined && belongsHere(channel, run.session) ? run : undefined;
};

/**
 * The stream the channel follows: the main conversation still honours the
 * status's own `activeStream`, and otherwise it is the stream of the run in
 * flight, when that run is this conversation's. A run in another of the bot's
 * conversations is not followed here, so its frames never land in this one.
 */
export const conversationStreamOf = (
  channel: Channel | undefined,
): StreamStatusView | undefined => {
  if (channel === undefined) return undefined;
  const legacy = Option.getOrUndefined(statusOf(channel))?.activeStream;
  if (channel.thread === undefined && legacy !== undefined) return legacy;
  return conversationRunOf(channel)?.stream;
};

/** The pending approvals the conversation the channel shows is waiting on. */
export const conversationApprovalsOf = (channel: Channel | undefined): readonly ApprovalView[] =>
  channel === undefined
    ? []
    : Option.match(statusOf(channel), {
        onNone: () => [],
        onSome: (view) =>
          view.approvals.filter(
            (approval) => approval.status === "pending" && belongsHere(channel, approval.session),
          ),
      });

/** The bot's conversations, as far as the list has loaded. */
export const threadsOf = (channel: Channel | undefined): readonly ThreadView[] =>
  channel === undefined
    ? []
    : Option.match(AsyncData.getData(channel.threads), {
        onNone: () => [],
        onSome: (list) => list.threads,
      });

/** The list's entry for the conversation the channel shows, once it has one. */
export const currentThreadOf = (channel: Channel | undefined): ThreadView | undefined =>
  threadsOf(channel).find((view) => view.thread === channel?.thread);
