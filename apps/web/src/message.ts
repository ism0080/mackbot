import {
  BotConfigSchema,
  BotViewSchema,
  FrameSchema,
  ModelCatalogSchema,
  RosterSchema,
  ThinkingLevelSchema,
  ThreadListSchema,
  TranscriptPageSchema,
} from "@mackbot/contract";
import { Dialog } from "@foldkit/ui";
import { defineMessageUnion } from "foldkit/message";
import * as Schema from "effect/Schema";

import { Toast } from "./toast.ts";

export const Message = defineMessageUnion({
  /** A poll tick. Update turns it into the `Status` Command unless one is
   *  already outstanding. */
  PolledStatus: {},
  /** One decoded SSE frame, with the sequence number of its `id:` line as the
   *  resume cursor. A frame that came without a usable id carries none, and
   *  leaves the cursor where it was. stream names the connection it came
   *  from, so a frame still in flight from a conversation the person has left
   *  is not folded into the one they opened. */
  FrameReceived: {
    bot: Schema.String,
    stream: Schema.optional(Schema.String),
    frame: FrameSchema,
    seq: Schema.optional(Schema.Number),
  },
  /** The stream reached its durable tail. */
  StreamUpToDate: { bot: Schema.String },
  /** A `done` or `error` control event: this stream is finished. */
  StreamClosed: { bot: Schema.String },
  /** The transport dropped with the stream unfinished; reconnecting is safe. */
  StreamDropped: { bot: Schema.String },
  /** The person asked for a bot's chat: the conversation they last had open
   *  with it, or its main one. */
  ClickedOpenTranscript: { bot: Schema.String },
  /** The person picked one of the bot's conversations; no thread is the main
   *  one. */
  ClickedOpenThread: { bot: Schema.String, thread: Schema.optional(Schema.String) },
  /** The person asked to start a new conversation with a bot. */
  ClickedNewThread: { bot: Schema.String },
  /** The new conversation has its id; the server learns of it with its first
   *  message. */
  ThreadStarted: { bot: Schema.String, thread: Schema.String },
  /** The person asked to take a conversation out of the bot's list. */
  ClickedArchiveThread: { bot: Schema.String, thread: Schema.String },
  /** The server archived the conversation. */
  ThreadArchived: { bot: Schema.String, thread: Schema.String },
  /** The archive did not reach the server, so the conversation is still listed. */
  ArchiveFailed: { bot: Schema.String, thread: Schema.String, error: Schema.String },
  ThreadsLoaded: { bot: Schema.String, threads: ThreadListSchema },
  ThreadsFailed: { bot: Schema.String, error: Schema.String },
  ClickedLoadEarlier: { bot: Schema.String },
  ClickedBack: {},
  /** The user asked for the bot picker, where a chat can be started. */
  ClickedNewChat: {},
  /** The user changed what the transcript's composer holds. */
  EditedChatText: { bot: Schema.String, text: Schema.String },
  /** The user sent the composer's text to a bot. */
  SubmittedChat: { bot: Schema.String },
  /** The server admitted the message, and names the operation it recorded.
   *  	hread is the conversation it was sent to. */
  ChatSent: {
    bot: Schema.String,
    thread: Schema.optional(Schema.String),
    operationId: Schema.String,
  },
  /** The message did not reach the bot, so the composer keeps its text. */
  ChatFailed: {
    bot: Schema.String,
    thread: Schema.optional(Schema.String),
    error: Schema.String,
  },
  DecidedApproval: {
    bot: Schema.String,
    approvalId: Schema.String,
    action: Schema.Literals(["allow", "deny"]),
  },
  /** The server recorded this client's decision, and says what it wrote. */
  ApprovalDecided: {
    bot: Schema.String,
    approvalId: Schema.String,
    status: Schema.Literals(["allowed", "denied"]),
    decidedAt: Schema.Number,
  },
  /** The approval was not pending, so another decider got there first. */
  ApprovalRefused: {
    bot: Schema.String,
    approvalId: Schema.String,
  },
  /** The decision did not reach the server, so the local claim is undone. */
  ApprovalFailed: {
    bot: Schema.String,
    approvalId: Schema.String,
    error: Schema.String,
  },
  /** The user asked for a bot's current work to stop. */
  ClickedStop: {
    bot: Schema.String,
    session: Schema.String,
  },
  /** The server stopped what was running, and says whether anything was. */
  StoppedBot: {
    bot: Schema.String,
    session: Schema.String,
    aborted: Schema.Boolean,
  },
  /** The stop did not reach the server, so the work is still running. */
  StopFailed: {
    bot: Schema.String,
    error: Schema.String,
  },
  /** The user asked for a task the harness parked to run again. */
  ClickedRetry: {
    bot: Schema.String,
    taskId: Schema.String,
  },
  /** A periodic refresh of the open transcript while work is in flight. */
  PolledTranscript: { bot: Schema.String },
  /** The browser reported a URL change, from a push or the back button. */
  UrlChanged: { pathname: Schema.String },
  /** A link inside the app asked to navigate. */
  UrlRequested: { pathname: Schema.String },
  /** A link left the app, so the app opens it rather than navigating away. */
  ExternalUrlRequested: { href: Schema.String },
  /** The browser opened the link; the app's own screen is unchanged. */
  LinkOpened: { href: Schema.String },
  /** The navigation effect finished; the URL is already the screen's. */
  Navigated: {},
  /** The open transcript's scroller moved, and says whether its tail is in
   *  view. The scroll position is DOM state, so it arrives as a message rather
   *  than being read in the view. */
  ScrolledTranscript: { atBottom: Schema.Boolean },
  /** The person asked to be taken back to the newest entry. */
  ClickedJumpToLatest: {},
  /** The scroller is at the tail again, whether by the button or by hand. */
  ScrolledToLatest: {},
  /** The server ran the parked task again, and says whether it did. */
  TaskRetried: {
    bot: Schema.String,
    taskId: Schema.String,
    retried: Schema.Boolean,
  },
  /** The retry did not reach the server, so the task is still parked. */
  RetryFailed: {
    bot: Schema.String,
    taskId: Schema.String,
    error: Schema.String,
  },
  /** One of the toast stack's own messages: an entry arriving, animating
   *  out, being dismissed, or its timer elapsing. */
  GotToastMessage: { message: Toast.Message },
  /** One of the dialog's own messages: opening, closing, or a lifecycle step
   *  of the native element. */
  GotDialogMessage: { message: Dialog.Message },
  /** The user asked to read a drafted artifact at full size. */
  ClickedReviewApproval: { bot: Schema.String, approvalId: Schema.String },
  /** A disclosure on the home or the transcript was toggled, and says whether
   *  it is now open. */
  ToggledPanel: { id: Schema.String, isOpen: Schema.Boolean },
  StatusLoaded: {
    bots: Schema.Record(Schema.String, BotViewSchema),
    errors: Schema.Record(Schema.String, Schema.String),
    at: Schema.Number,
  },
  StatusFailed: { error: Schema.String, at: Schema.Number },
  /** A transcript page landed. 	hread is the conversation it was asked for,
   *  so a page for one the person has since left is dropped. */
  TranscriptLoaded: {
    bot: Schema.String,
    thread: Schema.optional(Schema.String),
    page: TranscriptPageSchema,
    before: Schema.optional(Schema.Number),
  },
  TranscriptFailed: {
    bot: Schema.String,
    thread: Schema.optional(Schema.String),
    error: Schema.String,
    before: Schema.optional(Schema.Number),
  },
  /** The page was shown or hidden. */
  ChangedVisibility: { visible: Schema.Boolean },
  /** The user asked to end this browser's session. */
  ClickedSignOut: {},
  /** The server cleared the session; the page is on its way to the login. */
  SignedOut: {},
  /** The sign-out did not reach the server, so the session is still open. */
  SignOutFailed: { error: Schema.String },
  /** The user asked for the roster, where the bots are edited. */
  ClickedOpenBots: {},
  /** The roster arrived, and its own values seed the screen's drafts. */
  RosterLoaded: { roster: RosterSchema },
  RosterFailed: { error: Schema.String },
  /** The model catalog arrived, so the pickers know the models and the levels
   *  each one supports. */
  CatalogLoaded: { catalog: ModelCatalogSchema },
  CatalogFailed: { error: Schema.String },
  /**
   * One editable field changed. `bot` names the bot whose draft changed, and
   * is `null` for the bot being created, which has no id yet.
   */
  EditedBotModel: { bot: Schema.NullOr(Schema.String), model: Schema.String },
  EditedBotLevel: {
    bot: Schema.NullOr(Schema.String),
    level: Schema.optional(ThinkingLevelSchema),
  },
  EditedBotPrompt: { bot: Schema.NullOr(Schema.String), prompt: Schema.String },
  EditedBotBrief: { bot: Schema.NullOr(Schema.String), brief: Schema.String },
  /** The id of the bot being created changed. */
  EditedNewBotId: { id: Schema.String },
  /** The user asked to store one bot's configuration. */
  ClickedSaveBot: { bot: Schema.String },
  /** The user asked to create the bot being drafted. */
  ClickedCreateBot: {},
  /** The server stored the bot, and says what it stored. */
  BotSaved: { id: Schema.String, bot: BotConfigSchema },
  /** The write did not reach the server, or the server refused it. */
  BotSaveFailed: { bot: Schema.String, error: Schema.String },
  /** The server created the bot, and says what it created. */
  BotCreated: { id: Schema.String, bot: BotConfigSchema },
  /** The create did not reach the server, or the server refused it. */
  BotCreateFailed: { error: Schema.String },
});
export type Message = typeof Message.Type;
