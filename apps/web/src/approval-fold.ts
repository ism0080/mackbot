/**
 * approval-fold — the one writer of an approval's state.
 *
 * Nothing else removes an approval from a view: the home's blocked list and
 * the transcript's waiting row are both folds over `status.approvals`, so a
 * write here retires — or restores — the approval everywhere it is shown.
 */
import type { ApprovalView } from "@mackbot/contract";
import { modifyFields } from "foldkit/struct";

import { modifyStatus } from "./channel.ts";
import type { Channel } from "./model.ts";

const withApproval = (
  channel: Channel,
  approvalId: string,
  change: (approval: ApprovalView) => ApprovalView,
): Channel =>
  modifyStatus(channel, (view) =>
    modifyFields(view, {
      approvals: (approvals) =>
        approvals.map((approval) =>
          approval.approvalId === approvalId ? change(approval) : approval,
        ),
    }),
  );

/**
 * This client's decision, shown before the server confirms it. The decision
 * time is the server's to stamp, so the optimistic flip leaves it unset rather
 * than guessing it from a clock the client last read seconds ago.
 */
export const decideApproval = (
  channel: Channel,
  approvalId: string,
  action: "allow" | "deny",
): Channel =>
  withApproval(channel, approvalId, (approval) => ({
    ...approval,
    status: action === "allow" ? "allowed" : "denied",
    decidedAt: undefined,
  }));

/** The server's word replaces the local claim, whichever way it disagrees. */
export const markApproval = (
  channel: Channel,
  approvalId: string,
  status: "allowed" | "denied",
  decidedAt: number,
): Channel => withApproval(channel, approvalId, (approval) => ({ ...approval, status, decidedAt }));

/**
 * Undo an optimistic decision. The decision is only ever offered for a pending
 * approval, so restoring `pending` and dropping `decidedAt` is the exact
 * inverse, and the card and the transcript row that the flip retired come back.
 */
export const revertApproval = (channel: Channel, approvalId: string): Channel =>
  withApproval(channel, approvalId, (approval) => ({
    ...approval,
    status: "pending",
    decidedAt: undefined,
  }));
