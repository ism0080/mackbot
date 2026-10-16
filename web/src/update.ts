import type { ApprovalView, BotView, EntryView, Frame, TranscriptPage } from "@mackbot/web-contract";
import { Option } from "effect";
import { AsyncData } from "foldkit";
import { modifyFields } from "foldkit/struct";
import type { Update } from "foldkit";

import { DecideApproval, Status, Transcript } from "./api.ts";
import { Message } from "./message.ts";
import { FRAME_WINDOW, Screen } from "./model.ts";
import type { Channel, Model } from "./model.ts";

const emptyChannel = (): Channel => ({
  status: AsyncData.Idle(),
  transcript: AsyncData.Idle(),
  stream: { phase: "idle", generation: 0, lastSeq: 0, attempt: 0 },
  frames: [],
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

const modifyStatus = (channel: Channel, change: (view: BotView) => BotView): Channel =>
  modifyFields(channel, { status: (status) => AsyncData.map(status, change) });

const upsertApproval = (view: BotView, approval: ApprovalView): BotView =>
  modifyFields(view, {
    approvals: (approvals) => [
      ...approvals.filter((existing) => existing.approvalId !== approval.approvalId),
      approval,
    ],
  });

const statusOfDecision = (decision: "allow" | "deny" | "expired"): ApprovalView["status"] =>
  decision === "allow" ? "allowed" : decision === "deny" ? "denied" : "expired";

const resolveApproval = (
  view: BotView,
  approvalId: string,
  decision: "allow" | "deny" | "expired",
  at: number,
): BotView =>
  modifyFields(view, {
    approvals: (approvals) =>
      approvals.map((approval) =>
        approval.approvalId === approvalId
          ? { ...approval, status: statusOfDecision(decision), decidedAt: at }
          : approval,
      ),
  });

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
          approval.approvalId === approvalId
            ? modifyFields(approval, {
                status: () => status,
                decidedAt: () => decidedAt,
              })
            : approval,
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
            ? modifyFields(approval, { status: () => "pending", decidedAt: () => undefined })
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
const applyFrame = (channel: Channel, frame: Frame, seq: number, at: number): Channel => {
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
      return { ...cursor, transcript: mergeEntriesInto(cursor.transcript, frame.entries) };
    case "message":
      return frame.phase === "end" && frame.entry !== undefined
        ? { ...cursor, transcript: mergeEntriesInto(cursor.transcript, [frame.entry]) }
        : cursor;
    case "approval":
      return modifyStatus(cursor, (view) => upsertApproval(view, frame.approval));
    case "approval_resolved":
      return modifyStatus(cursor, (view) =>
        resolveApproval(view, frame.approvalId, frame.decision, at),
      );
    case "run":
      return frame.phase === "end" ? modifyStatus(cursor, endRun) : cursor;
    case "task_failed":
      return modifyStatus(cursor, endRun);
    default:
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

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    PolledStatus: () =>
      model.polling
        ? { model }
        : { model: { ...model, polling: true }, commands: [Status()] },
    FrameReceived: ({ bot, frame, seq, at }) => ({
      model: withChannel(model, bot, (channel) => applyFrame(channel, frame, seq, at)),
    }),
    StreamUpToDate: ({ bot }) => ({
      model: withChannel(model, bot, (channel) => setStreamPhase(channel, "live")),
    }),
    StreamClosed: ({ bot }) => ({
      model: withChannel(model, bot, (channel) => setStreamPhase(channel, "closed")),
    }),
    StreamDropped: ({ bot }) => ({
      model: withChannel(model, bot, reconnect),
    }),
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
        model: modifyFields(
          withChannel(model, bot, (channel) =>
            decideInChannel(channel, approvalId, action, model.now),
          ),
          { toast: () => null },
        ),
        commands: [DecideApproval({ bot, approvalId, action })],
      };
    },
    ApprovalDecided: ({ bot, approvalId, status, decidedAt }) => ({
      // The optimistic flip already showed this; recording the server's own
      // `decidedAt` and status replaces a guess with the fact.
      model: modifyFields(
        withChannel(model, bot, (channel) => markApproval(channel, approvalId, status, decidedAt)),
        { toast: () => null },
      ),
    }),
    ApprovalRefused: () => ({
      // The approval is decided, but not by this client and not to a state the
      // 409 body names. The local flip already took it out of the pending set,
      // which is the one thing we do know, so keep it retired and refetch the
      // route that owns the real status rather than claim which decider won.
      model: modifyFields(model, {
        toast: () => ({ text: "That approval was already decided elsewhere." }),
      }),
      commands: [Status()],
    }),
    ApprovalFailed: ({ bot, approvalId, error }) => ({
      model: modifyFields(
        withChannel(model, bot, (channel) => revertApproval(channel, approvalId)),
        { toast: () => ({ text: `Couldn't record that decision (${error}). Try again.` }) },
      ),
    }),
    DismissedToast: () => ({ model: modifyFields(model, { toast: () => null }) }),
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
          // The status row names the stream the client should attach to; a new
          // generation is a new stream, so it also clears the previous run's
          // spent reconnect budget.
          stream:
            view?.activeStream === undefined
              ? current.stream
              : {
                  ...current.stream,
                  generation: view.activeStream.generation,
                  attempt:
                    view.activeStream.generation === current.stream.generation
                      ? current.stream.attempt
                      : 0,
                },
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
