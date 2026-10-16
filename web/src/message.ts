import { BotViewSchema, FrameSchema, TranscriptPageSchema } from "@mackbot/web-contract";
import { defineMessageUnion } from "foldkit/message";
import * as Schema from "effect/Schema";

export const Message = defineMessageUnion({
  /** A poll tick. Update turns it into the `Status` Command unless one is
   *  already outstanding. */
  PolledStatus: {},
  /** One decoded SSE frame, with the sequence number of its `id:` line as the
   *  resume cursor. */
  FrameReceived: {
    bot: Schema.String,
    frame: FrameSchema,
    seq: Schema.Number,
    at: Schema.Number,
  },
  /** The stream reached its durable tail. */
  StreamUpToDate: { bot: Schema.String },
  /** A `done` or `error` control event: this stream is finished. */
  StreamClosed: { bot: Schema.String },
  /** The transport dropped with the stream unfinished; reconnecting is safe. */
  StreamDropped: { bot: Schema.String },
  ClickedOpenTranscript: { bot: Schema.String },
  ClickedLoadEarlier: { bot: Schema.String },
  ClickedBack: {},
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
  DismissedToast: {},
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
