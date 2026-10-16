import { BotViewSchema, TranscriptPageSchema } from "@mackbot/web-contract";
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
 * Everything the client knows about one bot, keyed by that bot's id. The two
 * fields are the two routes: `/status` returns the `BotView`, and
 * `/transcript/:bot` returns the page. An approval lives only in
 * `status.approvals`, so deciding it is one write, and every view that shows it
 * — the triage home, its header count, the transcript's "waiting on you" row —
 * is a fold over this record rather than a second copy kept in step by hand.
 */
export const Channel = Schema.Struct({
  status: AsyncData.Schema(BotViewSchema, Schema.String).schema,
  transcript: AsyncData.Schema(TranscriptPageSchema, Schema.String).schema,
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
  channels: Schema.Record(Schema.String, Channel),
});
export type Model = typeof Model.Type;
