import { defineMessageUnion } from "foldkit/message";
import * as Schema from "effect/Schema";

export const Message = defineMessageUnion({
  ClickedOpenTranscript: { bot: Schema.String },
  ClickedBack: {},
  DecidedApproval: {
    bot: Schema.String,
    approvalId: Schema.String,
    action: Schema.Literals(["allow", "deny"]),
  },
});
export type Message = typeof Message.Type;
