import {
  BotViewSchema,
  FrameSchema,
  ModelCatalogSchema,
  RosterSchema,
  ThinkingLevelSchema,
  TranscriptPageSchema,
} from "@mackbot/contract";
import { AsyncData } from "foldkit";
import { defineTaggedUnion } from "foldkit/schema";
import * as Schema from "effect/Schema";

/**
 * What the browser is looking at. Every screen is a focus — a bot id — never a
 * copy of that bot's data, so a screen can never disagree with the channels.
 *
 * The roster screen shows every bot at once, so it has no single focus. It
 * holds the fleet's configuration rather than one bot's live state, which is
 * the one thing on screen that is a copy of the server's answer.
 */
export const Screen = defineTaggedUnion({
  Home: {},
  Transcript: { bot: Schema.String },
  NewChat: {},
  Bots: {},
});
export type Screen = typeof Screen.Type;

/**
 * The live events subscription's descriptor. It is the only reconnect input:
 * `lastSeq` is the cursor the next connection resumes from, and `attempt` is
 * what makes a dropped transport a *dependency change*, so the subscription
 * record recreates the stream rather than a retry loop living inside it.
 */
export const StreamState = Schema.Struct({
  phase: Schema.Literals(["idle", "live", "retrying", "closed"]),
  generation: Schema.Number,
  lastSeq: Schema.Number,
  attempt: Schema.Number,
});
export type StreamState = typeof StreamState.Type;

/** How many recent Frames one channel keeps. A devtools window, not history:
 *  the transcript owns history. */
export const FRAME_WINDOW = 50;

/**
 * The one transient line the server has to say out loud and the user can
 * dismiss: a decision that did not stick, or one another client had already
 * made. It is global rather than per-channel because only one is ever visible.
 */
export const Toast = Schema.Struct({
  text: Schema.String,
});
export type Toast = typeof Toast.Type;

/** A thinking level, as the contract names them. */
export type ThinkingLevel = typeof ThinkingLevelSchema.Type;

/**
 * The editable fields of one bot.
 *
 * The strings are loose on purpose: a bot that has not been filled in yet is
 * still a state the form can be in. `null` for a thinking level is the bot
 * declaring no level, which is not the same thing as the level named "none".
 */
export const BotDraftSchema = Schema.Struct({
  model: Schema.String,
  thinkingLevel: Schema.NullOr(ThinkingLevelSchema),
  systemPrompt: Schema.String,
  brief: Schema.String,
});
export type BotDraft = typeof BotDraftSchema.Type;

/** The draft a bot that is being created starts from: nothing filled in yet. */
export const EMPTY_DRAFT: BotDraft = {
  model: "",
  thinkingLevel: null,
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
  /**
   * Messages this client sent that the transcript has not confirmed yet, so a
   * send shows up immediately instead of after the next poll. A pending message
   * is retired by the first transcript entry with the same text.
   */
  pending: Schema.Array(Schema.String),
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
  /** The last server answer a view has to show; see {@link Toast}. */
  toast: Schema.NullOr(Toast),
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
