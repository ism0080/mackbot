import { BotIdSchema } from "@mackbot/contract";
import * as Schema from "effect/Schema";
import { AsyncData, Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import { decideApproval, markApproval, revertApproval } from "./approval-fold.ts";
import {
  ArchiveThread,
  Chat,
  CreateBot,
  DecideApproval,
  RetryTask,
  SaveBot,
  SignOut,
  StartThread,
  StopBot,
  Transcript,
} from "./api.ts";
import {
  channelOf,
  conversationStreamOf,
  emptyChannel,
  lookup,
  mergePage,
  newestEntryIdOf,
  prunePending,
  threadField,
  withChannel,
} from "./channel.ts";
import { dataOf } from "./data.ts";
import {
  closeDialog,
  foldDialog,
  foldToast,
  openDialog,
  withToast,
  type ToastVariant,
} from "./feedback-fold.ts";
import { safeHref } from "./link.ts";
import { Message } from "./message.ts";
import { botName } from "./partials.ts";
import { EMPTY_DRAFT, Screen } from "./model.ts";
import type { Channel, Model } from "./model.ts";
import {
  enterScreen,
  requestStatus,
  requestThreads,
  requestTranscript,
  settleStatus,
} from "./request-fold.ts";
import {
  botsOf,
  catalogOf,
  configOfDraft,
  editBotOrDraft,
  emptyFieldOf,
  levelFor,
  withBots,
} from "./roster-fold.ts";
import { ScrollToLatest } from "./scroll.ts";
import { Navigate, OpenLink, pathOf, screenOfPath } from "./route.ts";
import { applyFrame, followStatus, reconnect, setStreamPhase } from "./stream-fold.ts";

type Step = Update.Step<Model, Message>;

const toast =
  (variant: ToastVariant, text: string): Step =>
  (model) =>
    withToast(model, variant, text);

/** Move to a screen the app chose, and push its URL so a reload lands there. */
const navigate =
  (screen: Model["screen"]): Step =>
  (model) => ({
    model: modifyFields(model, { screen: () => screen }),
    commands: [Navigate({ path: pathOf(screen) })],
  });

/** Move to a screen and ask for what it shows, the way a click on a link does. */
const open =
  (screen: Model["screen"]): Step =>
  (model) =>
    Update.combine(model, [navigate(screen), enterScreen(screen)]);

/** One of a bot's conversations, as the screen that shows it. */
const conversationScreen = (bot: string, thread: string | undefined): Model["screen"] =>
  Screen.Transcript({ bot, ...threadField(thread) });

/** Whether `thread` is the conversation the bot's channel shows. */
const isShown = (model: Model, bot: string, thread: string | undefined): boolean =>
  channelOf(model, bot)?.thread === thread;

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    PolledStatus: () => (model.polling ? { model } : requestStatus(model)),
    ChangedVisibility: ({ visible }) =>
      // A tab that comes back has been showing a frozen screen, so it reads the
      // fleet straight away rather than waiting out the poll interval.
      Update.combine(
        modifyFields(model, { visible: () => visible }),
        visible ? [requestStatus] : [],
      ),
    FrameReceived: ({ bot, stream, frame, seq }) =>
      // A frame from a stream the channel no longer follows was in flight when
      // the person left that conversation; it is not this one's.
      stream !== undefined && conversationStreamOf(channelOf(model, bot))?.stream !== stream
        ? { model }
        : { model: withChannel(model, bot, (channel) => applyFrame(channel, frame, seq)) },
    StreamUpToDate: ({ bot }) => ({
      model: withChannel(model, bot, (channel) => setStreamPhase(channel, "live")),
    }),
    StreamClosed: ({ bot }) =>
      // The stream ends when the run does. Reading the transcript now catches
      // the final entries even if the last frame was the one that got away.
      requestTranscript(bot)(
        withChannel(model, bot, (channel) => setStreamPhase(channel, "closed")),
      ),
    PolledTranscript: ({ bot }) =>
      channelOf(model, bot) === undefined ? { model } : requestTranscript(bot)(model),
    StreamDropped: ({ bot }) => ({
      model: withChannel(model, bot, reconnect),
    }),
    ClickedBack: () => navigate(Screen.Home())(model),
    ClickedNewChat: () => navigate(Screen.NewChat())(model),
    UrlChanged: ({ pathname }) => {
      const screen = screenOfPath(pathname);
      // A navigation the app made itself has already moved the screen and
      // asked for what it shows; the URL change it causes is only the echo.
      if (pathOf(screen) === pathOf(model.screen)) return { model };
      return enterScreen(screen)(modifyFields(model, { screen: () => screen }));
    },
    UrlRequested: ({ pathname }) => {
      const screen = screenOfPath(pathname);
      return Update.combine(model, [
        (current) => ({
          model: modifyFields(current, { screen: () => screen }),
          commands: [Navigate({ path: pathname })],
        }),
        enterScreen(screen),
      ]);
    },
    ExternalUrlRequested: ({ href }) =>
      // Only a link the transcript was allowed to render is opened; anything
      // else that reached the DOM is not followed.
      safeHref(href) === undefined ? { model } : { model, commands: [OpenLink({ href })] },
    LinkOpened: () => ({ model }),
    Navigated: () => ({ model }),
    ScrolledTranscript: ({ atBottom }) => ({
      model: modifyFields(model, { atBottom: () => atBottom }),
    }),
    ClickedJumpToLatest: () => ({
      // The button goes the moment it is spent: waiting for the smooth scroll
      // to settle would leave it under the finger that pressed it.
      model: modifyFields(model, { atBottom: () => true }),
      commands: [ScrollToLatest()],
    }),
    ScrolledToLatest: () => ({ model: modifyFields(model, { atBottom: () => true }) }),
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
            pending: (pending) => [...pending, { text, after: newestEntryIdOf(current) }],
          }),
        ),
        commands: [Chat({ bot, text, ...threadField(channel.thread) })],
      };
    },
    ChatSent: ({ bot, thread }) =>
      // The admission opens a run, so the status names the new stream and the
      // transcript picks up the user entry the server just recorded. A send to
      // a thread may have just created it, so the conversation list is read
      // again too; a send to a conversation the person has since left only
      // changes the status.
      isShown(model, bot, thread)
        ? Update.combine(
            withChannel(model, bot, (channel) => modifyFields(channel, { sending: () => false })),
            [
              requestStatus,
              requestTranscript(bot),
              ...(thread === undefined ? [] : [requestThreads(bot)]),
            ],
          )
        : Update.combine(model, [requestStatus, requestThreads(bot)]),
    ChatFailed: ({ bot, thread, error }) =>
      withToast(
        isShown(model, bot, thread)
          ? withChannel(model, bot, (channel) => {
              const failed = channel.pending[channel.pending.length - 1];
              return modifyFields(channel, {
                sending: () => false,
                pending: (pending) => pending.slice(0, -1),
                // Put the message back where the person can retry it rather than
                // losing it to a failed request.
                draft: (draft) =>
                  draft.length === 0 && failed !== undefined ? failed.text : draft,
              });
            })
          : model,
        "Error",
        isShown(model, bot, thread)
          ? `Couldn't reach ${botName(bot)} (${error}). Your message is still here.`
          : `Couldn't reach ${botName(bot)} (${error}).`,
      ),
    ClickedOpenTranscript: ({ bot }) =>
      // Opening a transcript the home could not load is the retry. The bot's
      // chat is the conversation last open with it, so the home's row, which
      // previews that conversation, opens the one it shows.
      open(conversationScreen(bot, channelOf(model, bot)?.thread))(model),
    ClickedOpenThread: ({ bot, thread }) => open(conversationScreen(bot, thread))(model),
    ClickedNewThread: ({ bot }) => ({ model, commands: [StartThread({ bot })] }),
    ThreadStarted: ({ bot, thread }) => open(conversationScreen(bot, thread))(model),
    ClickedArchiveThread: ({ bot, thread }) => ({
      // The archive is a request, not a fact: the thread stays listed until
      // the server says it took it out.
      model,
      commands: [ArchiveThread({ bot, thread })],
    }),
    ThreadArchived: ({ bot, thread }) => {
      const screen = model.screen;
      const onArchived =
        screen._tag === "Transcript" && screen.bot === bot && screen.thread === thread;
      return Update.combine(model, [
        toast("Success", `Archived the conversation with ${botName(bot)}.`),
        requestThreads(bot),
        // An archived conversation is out of the list, so the screen that
        // showed it moves to the main one rather than to a thread nobody lists.
        ...(onArchived ? [open(conversationScreen(bot, undefined))] : []),
      ]);
    },
    ArchiveFailed: ({ bot, error }) =>
      withToast(
        model,
        "Error",
        `Couldn't archive the conversation with ${botName(bot)} (${error}).`,
      ),
    ThreadsLoaded: ({ bot, threads }) => ({
      model: withChannel(model, bot, (channel) =>
        modifyFields(channel, { threads: () => AsyncData.succeed(threads) }),
      ),
    }),
    ThreadsFailed: ({ bot, error }) => ({
      // A list already on screen stays: only a first load becomes the error.
      model: withChannel(model, bot, (channel) =>
        modifyFields(channel, {
          threads: (threads) => (dataOf(threads) === undefined ? AsyncData.fail(error) : threads),
        }),
      ),
    }),
    ClickedLoadEarlier: ({ bot }) => {
      const channel = channelOf(model, bot);
      const before = channel === undefined ? undefined : dataOf(channel.transcript)?.nextBefore;
      if (channel === undefined || before === undefined || channel.loadingEarlier) {
        return { model };
      }
      return {
        model: withChannel(model, bot, (current) =>
          modifyFields(current, { loadingEarlier: () => true }),
        ),
        commands: [Transcript({ bot, ...threadField(channel.thread), before })],
      };
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

      return Update.combine(model, [
        (current) => ({
          model: withChannel(current, bot, (channel) =>
            decideApproval(channel, approvalId, action),
          ),
          commands: [DecideApproval({ bot, approvalId, action })],
        }),
        // A decision taken while reading the draft closes the draft: the card
        // and the dialog are two views of one approval, so both retire together.
        ...(model.reviewing === approvalId ? [closeDialog] : []),
      ]);
    },
    ApprovalDecided: ({ bot, approvalId, status, decidedAt }) => ({
      // The optimistic flip already showed this; recording the server's own
      // `decidedAt` and status replaces a guess with the fact.
      model: withChannel(model, bot, (channel) =>
        markApproval(channel, approvalId, status, decidedAt),
      ),
    }),
    ApprovalRefused: () =>
      // The approval is decided, but not by this client and not to a state the
      // 409 body names. The local flip already took it out of the pending set,
      // which is the one thing we do know, so keep it retired and refetch the
      // route that owns the real status rather than claim which decider won.
      Update.combine(model, [
        toast("Warning", "That approval was already decided elsewhere."),
        requestStatus,
      ]),
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
    StoppedBot: ({ bot, aborted }) =>
      // The run that just stopped is gone from the server's view of the world,
      // so the status that named it has to be read again.
      Update.combine(model, [
        toast(
          "Success",
          aborted ? `Stopped ${botName(bot)}.` : `${botName(bot)} was already idle.`,
        ),
        requestStatus,
      ]),
    StopFailed: ({ bot, error }) =>
      withToast(model, "Error", `Couldn't stop ${botName(bot)} (${error}). Try again.`),
    ClickedRetry: ({ bot, taskId }) => ({
      // The retry is a request, not a fact: the task stays parked until the
      // server says it ran it again, so the model changes only on the answer.
      model,
      commands: [RetryTask({ bot, taskId })],
    }),
    TaskRetried: ({ bot, retried }) =>
      // The task that just ran is no longer parked, so the status that named it
      // as parked has to be read again.
      Update.combine(model, [
        toast(
          retried ? "Success" : "Info",
          retried
            ? `Reran ${botName(bot)}'s parked task.`
            : `${botName(bot)}'s task was no longer parked.`,
        ),
        requestStatus,
      ]),
    RetryFailed: ({ bot, error }) =>
      withToast(model, "Error", `Couldn't rerun ${botName(bot)}'s task (${error}). Try again.`),
    GotToastMessage: ({ message }) => foldToast(model, message),
    StatusLoaded: ({ bots, errors, at }) => {
      const ids = [...new Set([...Object.keys(bots), ...Object.keys(errors)])];
      const channels: Record<string, Channel> = { ...model.channels };
      for (const id of ids) {
        const current = lookup(channels, id) ?? emptyChannel();
        const view = lookup(bots, id);
        const withStatus: Channel = {
          ...current,
          status:
            view === undefined
              ? AsyncData.fail(lookup(errors, id) ?? "status unavailable")
              : AsyncData.succeed(view),
        };
        channels[id] = {
          ...withStatus,
          // The status row names the stream the client should attach to, when
          // the run it describes is in the conversation on screen.
          stream: followStatus(current.stream, conversationStreamOf(withStatus)),
        };
      }
      const loaded = modifyFields(model, {
        roster: () => AsyncData.succeed(null),
        now: () => at,
        channels: () => channels,
      });

      return Update.combine(loaded, [
        settleStatus,
        ...Object.keys(bots)
          .filter((id) => {
            const channel = lookup(channels, id);
            return channel === undefined || dataOf(channel.transcript) === undefined;
          })
          .map(requestTranscript),
      ]);
    },
    StatusFailed: ({ error, at }) =>
      settleStatus(modifyFields(model, { roster: () => AsyncData.fail(error), now: () => at })),
    TranscriptLoaded: ({ bot, thread, page, before }) => {
      // A page for a conversation the person has since left is not this one's.
      if (!isShown(model, bot, thread)) return { model };
      const channel = channelOf(model, bot);
      const previous = channel === undefined ? undefined : dataOf(channel.transcript);
      const merged = mergePage(previous, page, before);
      return {
        model: withChannel(model, bot, (current) =>
          prunePending(
            {
              ...current,
              // Each kind of read clears only its own flag, so an older page
              // landing never claims the newest page's request has finished.
              ...(before === undefined ? { refreshing: false } : { loadingEarlier: false }),
              transcript: AsyncData.succeed(merged),
            },
            merged.entries,
          ),
        ),
      };
    },
    TranscriptFailed: ({ bot, thread, error, before }) => ({
      model: !isShown(model, bot, thread)
        ? model
        : withChannel(model, bot, (channel) => ({
            ...channel,
            ...(before === undefined ? { refreshing: false } : { loadingEarlier: false }),
            // A failed page keeps the entries already rendered; only a first load,
            // which has nothing to keep, becomes the channel's error.
            transcript:
              dataOf(channel.transcript) === undefined ? AsyncData.fail(error) : channel.transcript,
          })),
    }),
    ClickedOpenBots: () =>
      Update.combine(model, [navigate(Screen.Bots()), enterScreen(Screen.Bots())]),
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
      return {
        model: editBotOrDraft(model, bot, {
          draft: (draft) =>
            modifyFields(draft, {
              model: () => chosen,
              thinkingLevel: (level) => levelFor(catalog, chosen, level),
            }),
          config: (config) =>
            modifyFields(config, {
              model: () => chosen,
              thinkingLevel: (level) => levelFor(catalog, chosen, level),
            }),
        }),
      };
    },
    EditedBotLevel: ({ bot, level }) => ({
      model: editBotOrDraft(model, bot, {
        draft: (draft) => modifyFields(draft, { thinkingLevel: () => level }),
        config: (config) => modifyFields(config, { thinkingLevel: () => level }),
      }),
    }),
    EditedBotPrompt: ({ bot, prompt }) => ({
      model: editBotOrDraft(model, bot, {
        draft: (draft) => modifyFields(draft, { systemPrompt: () => prompt }),
        config: (config) => modifyFields(config, { systemPrompt: () => prompt }),
      }),
    }),
    EditedBotBrief: ({ bot, brief }) => ({
      model: editBotOrDraft(model, bot, {
        draft: (draft) => modifyFields(draft, { brief: () => brief }),
        // An empty brief is a bot with no brief, which is what the wire says;
        // the server would refuse the empty string.
        config: (config) =>
          modifyFields(config, {
            brief: () => (brief.trim().length === 0 ? undefined : brief),
          }),
      }),
    }),
    EditedNewBotId: ({ id }) => ({
      model: modifyFields(model, { newBotId: () => id }),
    }),
    ClickedSaveBot: ({ bot }) => {
      const config = lookup(botsOf(model), bot);
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
    ClickedSignOut: () => ({ model, commands: [SignOut()] }),
    // The page is already loading the login screen; nothing here outlives it.
    SignedOut: () => ({ model }),
    SignOutFailed: ({ error }) => withToast(model, "Error", `Couldn't sign out (${error}).`),
  });
