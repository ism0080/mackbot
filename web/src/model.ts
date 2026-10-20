import { BotViewSchema, FrameSchema, TranscriptPageSchema } from "@mackbot/contract";
import { AsyncData } from "foldkit";
import { defineTaggedUnion } from "foldkit/schema";
import * as Schema from "effect/Schema";

/**
 * What the browser is looking at. Every screen is a focus — a bot id — never a
 * copy of that bot's data, so a screen can never disagree with the channels.
 */
export const Screen = defineTaggedUnion({
  Home: {},
  Transcript: { bot: Schema.String },
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
});
export type Model = typeof Model.Type;
