import { BotViewSchema, TranscriptPageSchema } from "@mackbot/web-contract";
import { defineMessageUnion } from "foldkit/message";
import * as Schema from "effect/Schema";

export const Message = defineMessageUnion({
  /** A poll tick. Update turns it into the `Status` Command unless one is
   *  already outstanding. */
  PolledStatus: {},
  ClickedOpenTranscript: { bot: Schema.String },
  ClickedLoadEarlier: { bot: Schema.String },
  ClickedBack: {},
  DecidedApproval: {
    bot: Schema.String,
    approvalId: Schema.String,
    action: Schema.Literals(["allow", "deny"]),
  },
  StatusLoaded: {
    bots: Schema.Record(Schema.String, BotViewSchema),
    errors: Schema.Record(Schema.String, Schema.String),
    at: Schema.Number,
  },
  StatusFailed: { error: Schema.String, at: Schema.Number },
  TranscriptLoaded: {
    bot: Schema.String,
    page: TranscriptPageSchema,
    before: Schema.optional(Schema.Number),
  },
  TranscriptFailed: { bot: Schema.String, error: Schema.String },
});
export type Message = typeof Message.Type;
