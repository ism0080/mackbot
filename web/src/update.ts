import type { ApprovalView, BotView } from "@mackbot/web-contract";
import { AsyncData } from "foldkit";
import { modifyFields } from "foldkit/struct";
import type { Update } from "foldkit";

import { FIXTURE_NOW } from "./fixture.ts";
import { Message } from "./message.ts";
import { Screen } from "./model.ts";
import type { Channel, Model } from "./model.ts";

const decideOne = (approval: ApprovalView, action: "allow" | "deny"): ApprovalView =>
  modifyFields(approval, {
    status: () => (action === "allow" ? "allowed" : "denied"),
    decidedAt: () => FIXTURE_NOW,
  });

const decideInStatus = (
  status: BotView,
  approvalId: string,
  action: "allow" | "deny",
): BotView =>
  modifyFields(status, {
    approvals: (approvals) =>
      approvals.map((approval) =>
        approval.approvalId === approvalId ? decideOne(approval, action) : approval,
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
): Channel =>
  modifyFields(channel, {
    status: (status) => AsyncData.map(status, (view) => decideInStatus(view, approvalId, action)),
  });

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ClickedBack: () => ({
      model: modifyFields(model, { screen: () => Screen.Home() }),
    }),
    ClickedOpenTranscript: ({ bot }) => ({
      model: modifyFields(model, { screen: () => Screen.Transcript({ bot }) }),
    }),
    DecidedApproval: ({ bot, approvalId, action }) => {
      const channel = model.channels[bot];
      if (channel === undefined) return { model };

      return {
        model: modifyFields(model, {
          channels: (channels) =>
            modifyFields(channels, {
              [bot]: (current) => decideInChannel(current, approvalId, action),
            }),
        }),
      };
    },
  });
