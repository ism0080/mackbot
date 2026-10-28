import type {
  ApprovalView,
  BotConfig,
  BotView,
  EntryView,
  Frame,
  ModelCatalog,
  TranscriptPage,
} from "@mackbot/contract";
import { BotIdSchema } from "@mackbot/contract";
import { Dialog } from "@foldkit/ui";
import { Option } from "effect";
import * as Schema from "effect/Schema";
import { AsyncData, Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import {
  Catalog,
  Chat,
  CreateBot,
  DecideApproval,
  RetryTask,
  Roster,
  SaveBot,
  Status,
  StopBot,
  Transcript,
} from "./api.ts";
import { CopyMessage } from "./clipboard.ts";
import { Message } from "./message.ts";
import { botName } from "./partials.ts";
import { EMPTY_DRAFT, FRAME_WINDOW, Screen } from "./model.ts";
import type { BotDraft, Channel, Model, ThinkingLevel } from "./model.ts";
import { Navigate, OpenLink, pathOf, screenOfPath } from "./route.ts";
import { Toast } from "./toast.ts";

const emptyChannel = (): Channel => ({
  status: AsyncData.Idle(),
  transcript: AsyncData.Idle(),
  stream: { phase: "idle", generation: 0, lastSeq: 0, attempt: 0 },
  frames: [],
  draft: "",
  sending: false,
  refreshing: false,
  pending: [],
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
): TranscriptPage => {
  if (previous === undefined) return page;
  if (before === undefined) {
    // A reload of the newest page keeps the older pages already on screen, and
    // keeps their cursor so "Load earlier" still points past the oldest entry
    // rather than past the newest page's first one.
    return {
      ...page,
      entries: mergeEntries(previous.entries, page.entries),
      nextBefore: previous.nextBefore,
    };
  }
  return { ...page, entries: [...page.entries, ...previous.entries] };
};

const decideOne = (approval: ApprovalView, action: "allow" | "deny", at: number): ApprovalView => ({
  ...approval,
  status: action === "allow" ? "allowed" : "denied",
  decidedAt: at,
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

const mergeEntries = (
  existing: readonly EntryView[],
  incoming: readonly EntryView[],
): readonly EntryView[] => {
  const byId = new Map(existing.map((entry) => [entry.id, entry]));
  for (const entry of incoming) byId.set(entry.id, entry);
  return [...byId.values()].sort((left, right) => left.id - right.id);
};

const mergeEntriesInto = (
  transcript: AsyncData.AsyncData<TranscriptPage, string>,
  entries: readonly EntryView[],
): AsyncData.AsyncData<TranscriptPage, string> =>
  AsyncData.map(transcript, (page) => ({ ...page, entries: mergeEntries(page.entries, entries) }));

/**
 * Retire the optimistic messages the transcript has caught up with. Matching on
 * the text is enough because a pending message is only ever this client's own
 * last few sends, and the first user entry carrying that text is the one the
 * server recorded for it.
 */
const confirmedPending = (
  pending: readonly string[],
  entries: readonly EntryView[],
): readonly string[] => {
  const recorded = new Set(
    entries.filter((entry) => entry.role === "user").map((entry) => entry.text),
  );
  return pending.filter((text) => !recorded.has(text));
};

const prunePending = (channel: Channel, entries: readonly EntryView[]): Channel =>
  modifyFields(channel, { pending: (pending) => confirmedPending(pending, entries) });

const modifyStatus = (channel: Channel, change: (view: BotView) => BotView): Channel =>
  modifyFields(channel, { status: (status) => AsyncData.map(status, change) });

/** A run that ended is no longer a reason to hold the connection. */
const endRun = (view: BotView): BotView => modifyFields(view, { activeRun: () => undefined });

/** The server's word replaces the local claim, whichever way it disagrees. */
const markApproval = (
  channel: Channel,
  approvalId: string,
  status: "allowed" | "denied",
  decidedAt: number,
): Channel =>
  modifyStatus(channel, (view) =>
    modifyFields(view, {
      approvals: (approvals) =>
        approvals.map((approval) =>
          approval.approvalId === approvalId ? { ...approval, status, decidedAt } : approval,
        ),
    }),
  );

/**
 * Undo an optimistic decision. The decision is only ever offered for a pending
 * approval, so restoring `pending` and dropping `decidedAt` is the exact
 * inverse, and the card and the transcript row that the flip retired come back.
 */
const revertApproval = (channel: Channel, approvalId: string): Channel =>
  modifyStatus(channel, (view) =>
    modifyFields(view, {
      approvals: (approvals) =>
        approvals.map((approval) =>
          approval.approvalId === approvalId
            ? { ...approval, status: "pending", decidedAt: undefined }
            : approval,
        ),
    }),
  );

const windowFrames = (frames: readonly Frame[], frame: Frame): readonly Frame[] => {
  const next = [...frames, frame];
  return next.length <= FRAME_WINDOW ? next : next.slice(next.length - FRAME_WINDOW);
};

/**
 * One Frame, one Channel change. The cursor advances on every frame — it is the
 * sequence number of the frame's `id:` line, so an acknowledgement cannot move
 * it — while a `snapshot`'s generation is the one thing that reseeds the fold.
 */
const applyFrame = (channel: Channel, frame: Frame, seq: number): Channel => {
  const generation = frame.kind === "snapshot" ? frame.generation : channel.stream.generation;
  const cursor: Channel = {
    ...channel,
    frames: windowFrames(channel.frames, frame),
    stream: {
      ...channel.stream,
      generation,
      lastSeq: seq,
      phase: channel.stream.phase === "idle" ? "live" : channel.stream.phase,
      // A new generation is a new stream, so a previous run's spent retry
      // budget does not carry into it. Within one generation the budget only
      // grows, which is what stops a failed reconnect from looping.
      attempt: generation === channel.stream.generation ? channel.stream.attempt : 0,
    },
  };

  switch (frame.kind) {
    case "snapshot":
    case "append":
      // A snapshot is the whole window at attachment; an append is what one
      // commit added. Both land in the same place: the transcript's entries,
      // with a locally-sent message retired by the first server copy of it.
      return prunePending(
        { ...cursor, transcript: mergeEntriesInto(cursor.transcript, frame.entries) },
        frame.entries,
      );
    case "run":
      return frame.phase === "end" ? modifyStatus(cursor, endRun) : cursor;
    case "task_failed":
      return modifyStatus(cursor, endRun);
    default:
      // `live`, `inbox` and `usage` change the in-flight tail, which `/status`
      // and the next poll already carry; nothing here needs a second copy.
      return cursor;
  }
};

const setStreamPhase = (channel: Channel, phase: Channel["stream"]["phase"]): Channel => ({
  ...channel,
  stream: { ...channel.stream, phase },
});

/** Attempts past this many drops close the stream: a bot that cannot be reached
 *  falls back to the status poll rather than reconnecting forever. */
const MAX_STREAM_ATTEMPTS = 5;

const reconnect = (channel: Channel): Channel => {
  if (channel.stream.phase === "closed") return channel;
  const attempt = channel.stream.attempt + 1;
  return {
    ...channel,
    stream: {
      ...channel.stream,
      phase: attempt > MAX_STREAM_ATTEMPTS ? "closed" : "retrying",
      attempt,
    },
  };
};

/** The roster's bots, or none at all when the roster is not in hand. */
const botsOf = (model: Model): Record<string, BotConfig> => {
  const roster = dataOf(model.registry);
  return roster === undefined ? {} : roster.bots;
};

/**
 * The roster with its bots replaced. The state of the fetch is kept, so a
 * roster that failed to refresh keeps saying so while the edits land.
 */
const withBots = (model: Model, bots: Record<string, BotConfig>): Model =>
  modifyFields(model, {
    registry: (registry) => AsyncData.map(registry, (roster) => ({ ...roster, bots })),
  });

/**
 * One bot's configuration, changed. The roster is the working copy, so the
 * edit lands in the roster's own entry and everything the form does not show
 * stays where it was.
 */
const editBot = (model: Model, bot: string, change: (config: BotConfig) => BotConfig): Model => {
  const roster = dataOf(model.registry);
  if (roster === undefined) return model;
  const config = roster.bots[bot];
  if (config === undefined) return model;
  return withBots(model, { ...roster.bots, [bot]: change(config) });
};

/** The catalog the pickers read, or an empty one when it has not arrived. */
const catalogOf = (model: Model): ModelCatalog => {
  const catalog = dataOf(model.catalog);
  return catalog === undefined ? { models: {} } : catalog;
};

/**
 * The level a bot may keep when its model changes. The catalog says which
 * levels a model supports, so a level the new model does not have goes back
 * to none — the rule the server holds as well.
 *
 * A model the catalog does not list — a Workers AI model — supports every
 * level, so nothing is taken away from it.
 */
const levelFor = (
  catalog: ModelCatalog,
  model: string,
  level: ThinkingLevel | null | undefined,
): ThinkingLevel | null => {
  if (level === undefined || level === null) return null;
  const supported = catalog.models[model];
  if (supported === undefined) return level;
  return supported.includes(level) ? level : null;
};

/** The field a configuration is missing, if any. The server refuses both, so
 *  the form refuses them before the round trip. */
const emptyFieldOf = (config: BotConfig): string | null =>
  config.model.trim().length === 0
    ? "model"
    : config.systemPrompt.trim().length === 0
      ? "system prompt"
      : null;

/** The draft of the bot being created, as the configuration the wire takes. */
const configOfDraft = (draft: BotDraft): BotConfig => ({
  model: draft.model,
  systemPrompt: draft.systemPrompt,
  thinkingLevel: draft.thinkingLevel ?? undefined,
  brief: draft.brief.trim().length === 0 ? undefined : draft.brief,
});

/** The vocabulary a toast is filed under, kept next to the fold that uses it. */
type ToastVariant = "Info" | "Success" | "Warning" | "Error";

/**
 * The toast stack's own update. `update` delegates every one of the stack's
 * messages here; the fold writes the next stack back into the Model, lifts the
 * submodel's Commands into this app's — the enter animation, and the timer
 * that retires a non-sticky entry — and hands the OutMessage on.
 */
const foldToast = Update.foldChild({
  update: Toast.update,
  read: (model: Model) => Option.some(model.toast),
  write: (model, next) => modifyFields(model, { toast: () => next }),
  toParentMessage: (message) => Message.GotToastMessage({ message }),
  // Nothing outside the stack depends on a toast being gone: the fold's own
  // write is the whole change, so the OutMessage retires quietly.
  foldOutMessage: Toast.OutMessage.match<Update.Step<Model, Message>>({
    DismissedToast: () => (model) => ({ model }),
  }),
});

/**
 * One answer restated as a toast. The stack owns the entry's id, its timer and
 * its animation, so a second answer stacks under the first instead of
 * replacing it, and neither needs dismissing by hand.
 */
const showToast = Update.foldChild({
  update: Toast.show,
  read: (model: Model) => Option.some(model.toast),
  write: (model, next) => modifyFields(model, { toast: () => next }),
  toParentMessage: (message) => Message.GotToastMessage({ message }),
  foldOutMessage: Toast.OutMessage.match<Update.Step<Model, Message>>({
    DismissedToast: () => (model) => ({ model }),
  }),
});

const withToast = (model: Model, variant: ToastVariant, text: string) =>
  showToast(model, { variant, payload: { text } });

const readDialog = (model: Model) => Option.some(model.dialog);

const writeDialog = (model: Model, next: Dialog.Model): Model =>
  modifyFields(model, { dialog: () => next });

const toGotDialogMessage = (message: Dialog.Message): Message =>
  Message.GotDialogMessage({ message });

/**
 * What a dialog closing means here: whatever draft it was showing is no longer
 * under review, so the Model stops naming it. The dialog's own open flag is the
 * dialog's to hold; this is the parent's half of the same fact.
 */
const foldDialogOutMessage = Dialog.OutMessage.match<Update.Step<Model, Message>>({
  Opened: () => (model) => ({ model }),
  Closed: () => (model) => ({ model: modifyFields(model, { reviewing: () => null }) }),
});

const foldDialog = Update.foldChild({
  update: Dialog.update,
  read: readDialog,
  write: writeDialog,
  toParentMessage: toGotDialogMessage,
  foldOutMessage: foldDialogOutMessage,
});

const openDialog = Update.foldChildStep({
  update: Dialog.open,
  read: readDialog,
  write: writeDialog,
  toParentMessage: toGotDialogMessage,
  foldOutMessage: foldDialogOutMessage,
});

const closeDialog = Update.foldChildStep({
  update: Dialog.close,
  read: readDialog,
  write: writeDialog,
  toParentMessage: toGotDialogMessage,
  foldOutMessage: foldDialogOutMessage,
});

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    PolledStatus: () =>
      model.polling ? { model } : { model: { ...model, polling: true }, commands: [Status()] },
    FrameReceived: ({ bot, frame, seq }) => ({
      model: withChannel(model, bot, (channel) => applyFrame(channel, frame, seq)),
    }),
    StreamUpToDate: ({ bot }) => ({
      model: withChannel(model, bot, (channel) => setStreamPhase(channel, "live")),
    }),
    StreamClosed: ({ bot }) => ({
      model: withChannel(model, bot, (channel) => setStreamPhase(channel, "closed")),
      // The stream ends when the run does. Reading the transcript now catches
      // the final entries even if the last frame was the one that got away.
      commands: [Transcript({ bot })],
    }),
    PolledTranscript: ({ bot }) => {
      const channel = channelOf(model, bot);
      if (channel === undefined || channel.refreshing) return { model };
      return {
        model: withChannel(model, bot, (current) =>
          modifyFields(current, { refreshing: () => true }),
        ),
        commands: [Transcript({ bot })],
      };
    },
    StreamDropped: ({ bot }) => ({
      model: withChannel(model, bot, reconnect),
    }),
    ClickedBack: () => ({
      model: modifyFields(model, { screen: () => Screen.Home() }),
      commands: [Navigate({ path: pathOf(Screen.Home()) })],
    }),
    ClickedNewChat: () => ({
      model: modifyFields(model, { screen: () => Screen.NewChat() }),
      commands: [Navigate({ path: pathOf(Screen.NewChat()) })],
    }),
    UrlChanged: ({ pathname }) => {
      const screen = screenOfPath(pathname);
      return {
        model: modifyFields(model, { screen: () => screen }),
        commands:
          screen._tag === "Transcript" && dataOf(transcriptOf(model, screen.bot)) === undefined
            ? [Transcript({ bot: screen.bot })]
            : [],
      };
    },
    UrlRequested: ({ pathname }) => ({
      model: modifyFields(model, { screen: () => screenOfPath(pathname) }),
      commands: [Navigate({ path: pathname })],
    }),
    ExternalUrlRequested: ({ href }) => ({ model, commands: [OpenLink({ href })] }),
    LinkOpened: () => ({ model }),
    ClickedCopy: ({ text }) => ({ model, commands: [CopyMessage({ text })] }),
    CopiedMessage: () => withToast(model, "Success", "Copied to clipboard."),
    CopyFailed: ({ error }) =>
      withToast(model, "Error", `Couldn't copy that (${error}). Select the text instead.`),
    Navigated: () => ({ model }),
    EditedChatText: ({ bot, text }) => ({
      model: withChannel(model, bot, (channel) => modifyFields(channel, { draft: () => text })),
    }),
    SubmittedChat: ({ bot }) => {
      const channel = channelOf(model, bot);
      const text = channel?.draft.trim() ?? "";
      if (channel === undefined || text.length === 0 || channel.sending) return { model };

      return {
        // The text leaves the box and joins the transcript as a pending bubble,
        // so a send is immediate while the server and its stream catch up.
        model: withChannel(model, bot, (current) =>
          modifyFields(current, {
            draft: () => "",
            sending: () => true,
            pending: (pending) => [...pending, text],
          }),
        ),
        commands: [Chat({ bot, text })],
      };
    },
    ChatSent: ({ bot }) => ({
      model: withChannel(model, bot, (channel) =>
        modifyFields(channel, { sending: () => false, refreshing: () => true }),
      ),
      // The admission opens a run, so the status names the new stream and the
      // transcript picks up the user entry the server just recorded.
      commands: [Status(), Transcript({ bot })],
    }),
    ChatFailed: ({ bot, error }) =>
      withToast(
        withChannel(model, bot, (channel) => {
          const failed = channel.pending[channel.pending.length - 1];
          return modifyFields(channel, {
            sending: () => false,
            pending: (pending) => pending.slice(0, -1),
            // Put the message back where the person can retry it rather than
            // losing it to a failed request.
            draft: (draft) => (draft.length === 0 ? (failed ?? draft) : draft),
          });
        }),
        "Error",
        `Couldn't reach ${botName(bot)} (${error}). Your message is still here.`,
      ),
    ClickedOpenTranscript: ({ bot }) => ({
      model: modifyFields(model, { screen: () => Screen.Transcript({ bot }) }),
      commands: [
        Navigate({ path: pathOf(Screen.Transcript({ bot })) }),
        // Opening a transcript the home could not load is the retry.
        ...(dataOf(transcriptOf(model, bot)) === undefined ? [Transcript({ bot })] : []),
      ],
    }),
    ClickedLoadEarlier: ({ bot }) => {
      const page = dataOf(transcriptOf(model, bot));
      return page?.nextBefore === undefined
        ? { model }
        : { model, commands: [Transcript({ bot, before: page.nextBefore })] };
    },
    ToggledPanel: ({ id, isOpen }) => ({
      model: modifyFields(model, {
        expanded: (expanded) => ({ ...expanded, [id]: isOpen }),
      }),
    }),
    ClickedReviewApproval: ({ approvalId }) =>
      // The dialog reads the approval from the channels rather than taking a
      // copy, so what it shows is the state the fleet last said.
      openDialog(modifyFields(model, { reviewing: () => approvalId })),
    GotDialogMessage: ({ message }) => foldDialog(model, message),
    DecidedApproval: ({ bot, approvalId, action }) => {
      if (channelOf(model, bot) === undefined) return { model };

      const decided = {
        model: withChannel(model, bot, (channel) =>
          decideInChannel(channel, approvalId, action, model.now),
        ),
        commands: [DecideApproval({ bot, approvalId, action })],
      };

      // A decision taken while reading the draft closes the draft: the card
      // and the dialog are two views of one approval, so both retire together.
      if (model.reviewing !== approvalId) return decided;
      const closing = closeDialog(decided.model);
      return {
        model: closing.model,
        commands: [...(decided.commands ?? []), ...(closing.commands ?? [])],
      };
    },
    ApprovalDecided: ({ bot, approvalId, status, decidedAt }) => ({
      // The optimistic flip already showed this; recording the server's own
      // `decidedAt` and status replaces a guess with the fact.
      model: withChannel(model, bot, (channel) =>
        markApproval(channel, approvalId, status, decidedAt),
      ),
    }),
    ApprovalRefused: () => {
      // The approval is decided, but not by this client and not to a state the
      // 409 body names. The local flip already took it out of the pending set,
      // which is the one thing we do know, so keep it retired and refetch the
      // route that owns the real status rather than claim which decider won.
      const next = withToast(model, "Warning", "That approval was already decided elsewhere.");
      return { model: next.model, commands: [...(next.commands ?? []), Status()] };
    },
    ApprovalFailed: ({ bot, approvalId, error }) =>
      withToast(
        withChannel(model, bot, (channel) => revertApproval(channel, approvalId)),
        "Error",
        `Couldn't record that decision (${error}). Try again.`,
      ),
    ClickedStop: ({ bot, session }) => ({
      // The stop is a request, not a fact: the run is still working until the
      // server says so, so the model only changes once the answer arrives.
      model,
      commands: [StopBot({ bot, session })],
    }),
    StoppedBot: ({ bot, aborted }) => {
      const next = withToast(
        model,
        "Success",
        aborted ? `Stopped ${botName(bot)}.` : `${botName(bot)} was already idle.`,
      );
      // The run that just stopped is gone from the server's view of the world,
      // so the status that named it has to be read again.
      return { model: next.model, commands: [...(next.commands ?? []), Status()] };
    },
    StopFailed: ({ bot, error }) =>
      withToast(model, "Error", `Couldn't stop ${botName(bot)} (${error}). Try again.`),
    ClickedRetry: ({ bot, taskId }) => ({
      // The retry is a request, not a fact: the task stays parked until the
      // server says it ran it again, so the model changes only on the answer.
      model,
      commands: [RetryTask({ bot, taskId })],
    }),
    TaskRetried: ({ bot, retried }) => {
      const next = withToast(
        model,
        retried ? "Success" : "Info",
        retried
          ? `Reran ${botName(bot)}'s parked task.`
          : `${botName(bot)}'s task was no longer parked.`,
      );
      // The task that just ran is no longer parked, so the status that named it
      // as parked has to be read again.
      return { model: next.model, commands: [...(next.commands ?? []), Status()] };
    },
    RetryFailed: ({ bot, error }) =>
      withToast(model, "Error", `Couldn't rerun ${botName(bot)}'s task (${error}). Try again.`),
    GotToastMessage: ({ message }) => foldToast(model, message),
    StatusLoaded: ({ bots, errors, at }) => {
      const ids = [...new Set([...Object.keys(bots), ...Object.keys(errors)])];
      const channels: Record<string, Channel> = { ...model.channels };
      for (const id of ids) {
        const current = lookup(channels, id) ?? emptyChannel();
        const view = lookup(bots, id);
        const generation = view?.activeStream?.generation;
        // A new generation is a new stream that starts at zero. Carrying the
        // previous stream's cursor over would ask the new stream to resume past
        // its own head, so the first frames — including the snapshot — would be
        // silently skipped.
        const rotated = generation !== undefined && generation !== current.stream.generation;
        channels[id] = {
          ...current,
          status:
            view === undefined
              ? AsyncData.fail(lookup(errors, id) ?? "status unavailable")
              : AsyncData.succeed(view),
          // The status row names the stream the client should attach to; a new
          // generation is a new stream, so it also clears the previous run's
          // spent reconnect budget.
          stream:
            view?.activeStream === undefined
              ? current.stream
              : {
                  ...current.stream,
                  generation: view.activeStream.generation,
                  lastSeq: rotated ? 0 : current.stream.lastSeq,
                  attempt: rotated ? 0 : current.stream.attempt,
                },
        };
      }
      const commands = Object.keys(bots)
        .filter((id) => dataOf(transcriptOf(model, id)) === undefined)
        .map((id) => Transcript({ bot: id }));

      return {
        model: { ...model, roster: AsyncData.succeed(null), now: at, channels, polling: false },
        commands,
      };
    },
    StatusFailed: ({ error, at }) => ({
      model: { ...model, roster: AsyncData.fail(error), now: at, polling: false },
    }),
    TranscriptLoaded: ({ bot, page, before }) => {
      const previous = dataOf(transcriptOf(model, bot));
      const merged = mergePage(previous, page, before);
      return {
        model: withChannel(model, bot, (channel) =>
          prunePending(
            { ...channel, refreshing: false, transcript: AsyncData.succeed(merged) },
            merged.entries,
          ),
        ),
      };
    },
    TranscriptFailed: ({ bot, error }) =>
      // A failed page keeps the entries already rendered; only a first load,
      // which has nothing to keep, becomes the channel's error.
      dataOf(transcriptOf(model, bot)) === undefined
        ? {
            model: withChannel(model, bot, (channel) => ({
              ...channel,
              refreshing: false,
              transcript: AsyncData.fail(error),
            })),
          }
        : {
            model: withChannel(model, bot, (channel) =>
              modifyFields(channel, { refreshing: () => false }),
            ),
          },
    ClickedOpenBots: () => ({
      // The roster and the catalog are asked for every time the screen opens,
      // so what it shows is the server's truth rather than a stale copy.
      model: modifyFields(model, { screen: () => Screen.Bots() }),
      commands: [Navigate({ path: pathOf(Screen.Bots()) }), Roster(), Catalog()],
    }),
    RosterLoaded: ({ roster }) => ({
      // The roster's own values seed the screen: it is the working copy, so an
      // edit lands on top of what the server said.
      model: modifyFields(model, { registry: () => AsyncData.succeed(roster) }),
    }),
    RosterFailed: ({ error }) => ({
      model: modifyFields(model, { registry: () => AsyncData.fail(error) }),
    }),
    CatalogLoaded: ({ catalog }) => ({
      model: modifyFields(model, { catalog: () => AsyncData.succeed(catalog) }),
    }),
    CatalogFailed: ({ error }) => ({
      model: modifyFields(model, { catalog: () => AsyncData.fail(error) }),
    }),
    EditedBotModel: ({ bot, model: chosen }) => {
      const catalog = catalogOf(model);
      if (bot === null) {
        return {
          model: modifyFields(model, {
            draft: (draft) =>
              modifyFields(draft, {
                model: () => chosen,
                thinkingLevel: (level) => levelFor(catalog, chosen, level),
              }),
          }),
        };
      }
      return {
        model: editBot(model, bot, (config) =>
          modifyFields(config, {
            model: () => chosen,
            thinkingLevel: (level) => levelFor(catalog, chosen, level) ?? undefined,
          }),
        ),
      };
    },
    EditedBotLevel: ({ bot, level }) =>
      bot === null
        ? {
            model: modifyFields(model, {
              draft: (draft) => modifyFields(draft, { thinkingLevel: () => level }),
            }),
          }
        : {
            // A bot that declares no level has no level at all, which is what
            // the wire says.
            model: editBot(model, bot, (config) =>
              modifyFields(config, { thinkingLevel: () => level ?? undefined }),
            ),
          },
    EditedBotPrompt: ({ bot, prompt }) =>
      bot === null
        ? {
            model: modifyFields(model, {
              draft: (draft) => modifyFields(draft, { systemPrompt: () => prompt }),
            }),
          }
        : {
            model: editBot(model, bot, (config) =>
              modifyFields(config, { systemPrompt: () => prompt }),
            ),
          },
    EditedBotBrief: ({ bot, brief }) =>
      bot === null
        ? {
            model: modifyFields(model, {
              draft: (draft) => modifyFields(draft, { brief: () => brief }),
            }),
          }
        : {
            // An empty brief is a bot with no brief, which is what the wire
            // says; the server would refuse the empty string.
            model: editBot(model, bot, (config) =>
              modifyFields(config, {
                brief: () => (brief.trim().length === 0 ? undefined : brief),
              }),
            ),
          },
    EditedNewBotId: ({ id }) => ({
      model: modifyFields(model, { newBotId: () => id }),
    }),
    ClickedSaveBot: ({ bot }) => {
      const roster = dataOf(model.registry);
      const config = roster === undefined ? undefined : roster.bots[bot];
      if (config === undefined) return { model };
      const empty = emptyFieldOf(config);
      if (empty !== null) {
        return withToast(model, "Warning", `Couldn't save ${botName(bot)}: the ${empty} is empty.`);
      }
      return { model, commands: [SaveBot({ bot, config })] };
    },
    ClickedCreateBot: () => {
      const id = model.newBotId.trim();
      if (id.length === 0) {
        return withToast(model, "Warning", "The new bot needs an id.");
      }
      if (!Schema.is(BotIdSchema)(id)) {
        return withToast(
          model,
          "Warning",
          "The id has to be a slug: lowercase letters, digits and dashes.",
        );
      }
      const config = configOfDraft(model.draft);
      const empty = emptyFieldOf(config);
      if (empty !== null) {
        return withToast(model, "Warning", `The new bot needs a ${empty}.`);
      }
      return { model, commands: [CreateBot({ id, bot: config })] };
    },
    BotSaved: ({ id, bot }) =>
      // The server's answer is the bot as it is now stored, so the working copy
      // takes it rather than the edit that was sent.
      withToast(
        withBots(model, { ...botsOf(model), [id]: bot }),
        "Success",
        `Saved ${botName(id)}.`,
      ),
    BotSaveFailed: ({ bot, error }) =>
      withToast(model, "Error", `Couldn't save ${botName(bot)} (${error}).`),
    BotCreated: ({ id, bot }) =>
      withToast(
        modifyFields(withBots(model, { ...botsOf(model), [id]: bot }), {
          draft: () => EMPTY_DRAFT,
          newBotId: () => "",
        }),
        "Success",
        `Added ${botName(id)}.`,
      ),
    BotCreateFailed: ({ error }) => withToast(model, "Error", `Couldn't add the bot (${error}).`),
  });
