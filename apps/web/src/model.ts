import {
  BotViewSchema,
  FrameSchema,
  ModelCatalogSchema,
  RosterSchema,
  ThinkingLevelSchema,
  ThreadListSchema,
  TranscriptPageSchema,
} from "@mackbot/contract";
import { Dialog } from "@foldkit/ui";
import { AsyncData } from "foldkit";
import { defineTaggedUnion } from "foldkit/schema";
import * as Schema from "effect/Schema";

import { Toast } from "./toast.ts";

/**
 * What the browser is looking at. Every screen is a focus — a bot id — never a
 * copy of that bot's data, so a screen can never disagree with the channels.
 * A transcript also names the conversation it shows: absent is the bot's main
 * conversation, and a thread id is one the person started beside it.
 *
 * The roster screen shows every bot at once, so it has no single focus. It
 * holds the fleet's configuration rather than one bot's live state, which is
 * the one thing on screen that is a copy of the server's answer.
 *
 * The archive screen lists the conversations a person put away with one bot,
 * and is where they are restored.
 */
export const Screen = defineTaggedUnion({
  Home: {},
  Transcript: { bot: Schema.String, thread: Schema.optional(Schema.String) },
  Archive: { bot: Schema.String },
  NewChat: {},
  Bots: {},
});
export type Screen = typeof Screen.Type;

/**
 * The live events subscription's descriptor. It is the only reconnect input:
 * `lastSeq` is the cursor the next connection resumes from, and `attempt` is
 * what makes a dropped transport a *dependency change*, so the subscription
 * record recreates the stream rather than a retry loop living inside it.
 *
 * `failures` counts the drops since the last frame that arrived. It sets how
 * long the next connection waits and when the stream gives up, and a frame
 * clears it without touching `attempt`, so a recovered connection is not torn
 * down just to reset the count.
 */
export const StreamState = Schema.Struct({
  phase: Schema.Literals(["idle", "live", "retrying", "closed"]),
  generation: Schema.Number,
  lastSeq: Schema.Number,
  attempt: Schema.Number,
  failures: Schema.Number,
});
export type StreamState = typeof StreamState.Type;

/** How many recent Frames one channel keeps. A devtools window, not history:
 *  the transcript owns history. */
export const FRAME_WINDOW = 50;

/**
 * A message this client sent that the transcript has not shown yet. `after` is
 * the newest entry id the client knew of when it sent it: the server records a
 * send after everything already in the thread, so only a user entry past that
 * id can be this message's copy, and an older entry with the same words never
 * retires it.
 */
export const PendingMessage = Schema.Struct({
  text: Schema.String,
  after: Schema.Number,
});
export type PendingMessage = typeof PendingMessage.Type;

/** A thinking level, as the contract names them. */
export type ThinkingLevel = typeof ThinkingLevelSchema.Type;

/**
 * The editable fields of one bot.
 *
 * The strings are loose on purpose: a bot that has not been filled in yet is
 * still a state the form can be in. An absent thinking level is the bot
 * declaring no level, as the wire says, which is not the same thing as the
 * level named "none".
 */
export const BotDraftSchema = Schema.Struct({
  model: Schema.String,
  thinkingLevel: Schema.optional(ThinkingLevelSchema),
  systemPrompt: Schema.String,
  brief: Schema.String,
});
export type BotDraft = typeof BotDraftSchema.Type;

/** The draft a bot that is being created starts from: nothing filled in yet. */
export const EMPTY_DRAFT: BotDraft = {
  model: "",
  systemPrompt: "",
  brief: "",
};

/**
 * Everything the client knows about one bot, keyed by that bot's id. The two
 * routes fill `status` and `transcript`; `frames` is what the SSE subscription
 * has folded in since, so an approval or a settled message that arrived while
 * the app was open is in the same record the routes wrote rather than a second
 * copy kept in step by hand.
 */
export const Channel = Schema.Struct({
  status: AsyncData.Schema(BotViewSchema, Schema.String).schema,
  /**
   * The conversation the rest of the channel is about — its transcript, its
   * stream, the draft and the messages in flight. Absent is the bot's main
   * conversation. Opening another one starts those fields afresh, so one
   * conversation's words never land in another's.
   */
  thread: Schema.optional(Schema.String),
  /** The bot's conversations, for the list the transcript screen offers. */
  threads: AsyncData.Schema(ThreadListSchema, Schema.String).schema,
  /**
   * The bot's conversations with the archived ones included, for the archive
   * screen. It is a separate read from `threads`, which leaves them out.
   */
  archived: AsyncData.Schema(ThreadListSchema, Schema.String).schema,
  transcript: AsyncData.Schema(TranscriptPageSchema, Schema.String).schema,
  stream: StreamState,
  frames: Schema.Array(FrameSchema),
  /** What the person has typed into this bot's composer but not yet sent. */
  draft: Schema.String,
  /** Whether a `POST /chat/:bot` for this bot is still in flight. */
  sending: Schema.Boolean,
  /** Whether a transcript request for this bot is in flight, so the poll does
   *  not stack a second one on top. */
  refreshing: Schema.Boolean,
  /** Whether an older page is in flight, so a second press of "Load earlier"
   *  does not ask for the same page again. */
  loadingEarlier: Schema.Boolean,
  /**
   * Messages this client sent that the transcript has not confirmed yet, so a
   * send shows up immediately instead of after the next poll. A pending message
   * is retired by the first user entry past its `after` with the same text.
   */
  pending: Schema.Array(PendingMessage),
});
export type Channel = typeof Channel.Type;

export const Model = Schema.Struct({
  screen: Screen,
  /**
   * Whether a `/status` request is outstanding. A poll that fires while one is
   * still in flight must not dispatch a second one, so the gate lives in the
   * Model where the poll can read it rather than in the Command.
   */
  polling: Schema.Boolean,
  /**
   * Whether something changed on the server while a `/status` request was
   * already in flight. That answer may predate the change, so its arrival asks
   * again rather than letting an older answer stand.
   */
  statusStale: Schema.Boolean,
  /** Whether the page is visible. A hidden tab has nobody reading it, so the
   *  polls pause until it is shown again. */
  visible: Schema.Boolean,
  /**
   * The client's clock, minted by the status Command and carried on its result.
   * Relative labels ("waiting 4m") are a function of it, and a view cannot read
   * a clock without making the same Model render differently over time.
   */
  now: Schema.Number,
  /**
   * The roster fetch itself, so the home can tell "no bots yet" from "the
   * fleet did not answer". Per-bot failures are their own channel's `status`.
   */
  roster: AsyncData.Schema(Schema.Null, Schema.String).schema,
  /**
   * The transient answers the server has to say out loud: a decision that did
   * not stick, or one another client had already made. It is a stack rather
   * than one slot, and it is global rather than per-channel because a bot's
   * answer is about the screen the person is looking at, not the thread.
   */
  toast: Toast.Model,
  /**
   * The dialog that reads a drafted artifact at full size. The native element
   * traps the focus and makes the screen behind it inert, so the decision is
   * taken with the whole draft in front of the person rather than a peek line.
   */
  dialog: Dialog.Model,
  /** The approval whose draft the dialog is showing, named by id so the
   *  dialog reads the approval's current state rather than a copy. */
  reviewing: Schema.NullOr(Schema.String),
  /**
   * The disclosures a person has toggled, by panel id. A tool result, a long
   * message's tail and an approval's draft all fold, and the Model is what
   * remembers it: a panel's open state cannot be lost to a re-render the way a
   * browser-owned `<details>` can, and a failed tool result can default open
   * without becoming impossible to close.
   */
  expanded: Schema.Record(Schema.String, Schema.Boolean),
  /**
   * Whether the open transcript is scrolled to its newest entry. A chat that
   * has moved on while the person reads history needs one way back, and
   * whether it has moved is DOM state: the scroll listener reports it, the
   * Model holds it, and the view only decides whether to offer the button.
   */
  atBottom: Schema.Boolean,
  channels: Schema.Record(Schema.String, Channel),
  /**
   * The roster being edited: the server's bots with the edits on top.
   *
   * It is the working copy rather than a copy of the truth, so a save sends a
   * bot's whole configuration back and the fields the form does not show — the
   * delegate list, the run policy and the commitments flag — survive the
   * round trip untouched.
   */
  registry: AsyncData.Schema(RosterSchema, Schema.String).schema,
  /** The model catalog the pickers read. The Worker owns it, so it arrives
   *  over the wire rather than being bundled into the browser. */
  catalog: AsyncData.Schema(ModelCatalogSchema, Schema.String).schema,
  /** The bot being created. */
  draft: BotDraftSchema,
  /** The id the bot being created will be given. */
  newBotId: Schema.String,
});
export type Model = typeof Model.Type;
