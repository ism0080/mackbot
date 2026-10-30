import { AsyncData } from "foldkit";
import { Command, given, message, model, story } from "foldkit/story";
import { describe, expect, test } from "vitest";

import { Dialog } from "@foldkit/ui";

import { DecideApproval, Status } from "../src/api.ts";
import { Message } from "../src/message.ts";
import type { Model } from "../src/model.ts";
import { update } from "../src/update.ts";
import { FIXTURE_NOW, approvalOf, modelWith, rosterOf, statusOf } from "./support/fixtures.ts";
import { botChannel, statusIn } from "./support/story.ts";
import { drainToast, settleToast, toastEntry, toastText } from "./support/toast.ts";

const at = FIXTURE_NOW;

const approvalsOf = () => [
  approvalOf(),
  approvalOf({ approvalId: "apr_other", summary: "Deploy the release?", toolPath: "deploy.run" }),
];

/** A model whose hermes channel has two pending approvals. */
const seeded = () => ({
  ...modelWith({ now: at }),
  channels: {
    hermes: botChannel("hermes", {
      status: AsyncData.succeed(statusOf({ approvals: approvalsOf() })),
    }),
  },
});

const approvalIn = (m: Model, approvalId: string) => {
  const approval = statusIn(m, "hermes").approvals.find((item) => item.approvalId === approvalId);
  if (approval === undefined) throw new Error(`no approval "${approvalId}"`);
  return approval;
};

/** The id the app gives the draft dialog; the Worker's own attribute is not
 *  involved, so the test names it once here. */
const DIALOG_ID = "approval-draft";

const closeDialog = () => Dialog.CloseDialog({ id: DIALOG_ID });

/**
 * Reading a draft, as the parent sees it: the fact, the two Commands the
 * dialog's update emits for the native element — the plain open, and the one
 * that names the element to focus — and the browser's answer to each.
 */
const opened = () => [
  message(Message.ClickedReviewApproval({ bot: "hermes", approvalId: "apr_send" })),
  // The definition matcher, so the test does not restate the focus selector the
  // dialog derives for itself.
  Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
];

describe("deciding an approval", () => {
  test("DecidedApproval flips that approval and emits the decision Command", () => {
    story(
      update,
      given(seeded()),
      message(Message.DecidedApproval({ bot: "hermes", approvalId: "apr_send", action: "allow" })),
      Command.expectExact(
        DecideApproval({ bot: "hermes", approvalId: "apr_send", action: "allow" }),
      ),
      model((m) => {
        const decided = approvalIn(m, "apr_send");
        expect(decided.status).toBe("allowed");

        const other = approvalIn(m, "apr_other");
        expect(other.status).toBe("pending");
        expect(other.decidedAt).toBeUndefined();

        // The decision time is the server's to stamp, so the optimistic flip
        // leaves it unset rather than guessing.
        expect(decided.decidedAt).toBeUndefined();
      }),
      Command.resolve(
        DecideApproval({ bot: "hermes", approvalId: "apr_send", action: "allow" }),
        Message.ApprovalDecided({
          bot: "hermes",
          approvalId: "apr_send",
          status: "allowed",
          decidedAt: at + 1_000,
        }),
      ),
    );
  });

  test("a deny decision writes denied", () => {
    story(
      update,
      given(seeded()),
      message(Message.DecidedApproval({ bot: "hermes", approvalId: "apr_send", action: "deny" })),
      Command.expectExact(
        DecideApproval({ bot: "hermes", approvalId: "apr_send", action: "deny" }),
      ),
      model((m) => {
        expect(approvalIn(m, "apr_send").status).toBe("denied");
      }),
      Command.resolve(
        DecideApproval({ bot: "hermes", approvalId: "apr_send", action: "deny" }),
        Message.ApprovalDecided({
          bot: "hermes",
          approvalId: "apr_send",
          status: "denied",
          decidedAt: at + 1_000,
        }),
      ),
    );
  });

  test("ApprovalDecided replaces the optimistic claim with the server's answer", () => {
    const optimistic = {
      ...seeded(),
      channels: {
        hermes: botChannel("hermes", {
          status: AsyncData.succeed(
            statusOf({
              approvals: [
                approvalOf({ status: "allowed", decidedAt: at }),
                approvalOf({ approvalId: "apr_other" }),
              ],
            }),
          ),
        }),
      },
    };

    story(
      update,
      given(optimistic),
      message(
        Message.ApprovalDecided({
          bot: "hermes",
          approvalId: "apr_send",
          status: "denied",
          decidedAt: at + 5_000,
        }),
      ),
      Command.expectNone(),
      model((m) => {
        const approval = approvalIn(m, "apr_send");
        expect(approval.status).toBe("denied");
        expect(approval.decidedAt).toBe(at + 5_000);
      }),
    );
  });

  test("ApprovalFailed reverts to pending and says the decision did not stick", () => {
    const optimistic = {
      ...seeded(),
      channels: {
        hermes: botChannel("hermes", {
          status: AsyncData.succeed(
            statusOf({ approvals: [approvalOf({ status: "allowed", decidedAt: at })] }),
          ),
        }),
      },
    };

    story(
      update,
      given(optimistic),
      message(Message.ApprovalFailed({ bot: "hermes", approvalId: "apr_send", error: "boom" })),
      settleToast(),
      model((m) => {
        const approval = approvalIn(m, "apr_send");
        expect(approval.status).toBe("pending");
        expect(approval.decidedAt).toBeUndefined();
        expect(toastText(m)).toBe("Couldn't record that decision (boom). Try again.");
      }),
    );
  });

  test("ApprovalRefused keeps the retired approval and refetches the status", () => {
    // The local flip already took this approval out of the pending set; the 409
    // does not name a winning state, so the refusal only asks for fresh status.
    const seededRefused = {
      ...seeded(),
      polling: false,
      channels: {
        hermes: botChannel("hermes", {
          status: AsyncData.succeed(
            statusOf({ approvals: [approvalOf({ status: "allowed", decidedAt: at })] }),
          ),
        }),
      },
    };

    story(
      update,
      given(seededRefused),
      message(Message.ApprovalRefused({ bot: "hermes", approvalId: "apr_send" })),
      settleToast(),
      Command.expectExact(Status),
      model((m) => {
        expect(toastText(m)).toBe("That approval was already decided elsewhere.");
        expect(approvalIn(m, "apr_send").status).toBe("allowed");
      }),
      Command.resolve(Status, Message.StatusFailed({ error: "offline", at })),
    );
  });

  test("reading a draft opens the dialog on the approval under review", () => {
    story(
      update,
      given(seeded()),
      ...opened(),
      model((m) => {
        expect(m.reviewing).toBe("apr_send");
        expect(m.dialog.isOpen).toBe(true);
      }),
    );
  });

  test("a decision taken while reading the draft closes it", () => {
    story(
      update,
      given(seeded()),
      ...opened(),
      message(Message.DecidedApproval({ bot: "hermes", approvalId: "apr_send", action: "deny" })),
      Command.expectExact(
        DecideApproval({ bot: "hermes", approvalId: "apr_send", action: "deny" }),
        closeDialog(),
      ),
      Command.resolve(closeDialog(), Dialog.Message.CompletedCloseDialog()),
      settleToast(),
      model((m) => {
        // The decision retires the dialog as well as the card: both are views
        // of the same approval.
        expect(m.dialog.isOpen).toBe(false);
        expect(approvalIn(m, "apr_send").status).toBe("denied");
      }),
      Command.resolve(
        DecideApproval({ bot: "hermes", approvalId: "apr_send", action: "deny" }),
        Message.ApprovalDecided({
          bot: "hermes",
          approvalId: "apr_send",
          status: "denied",
          decidedAt: at,
        }),
      ),
    );
  });

  test("a decision on another approval leaves the open draft alone", () => {
    story(
      update,
      given(seeded()),
      ...opened(),
      message(Message.DecidedApproval({ bot: "hermes", approvalId: "apr_other", action: "allow" })),
      Command.expectExact(
        DecideApproval({ bot: "hermes", approvalId: "apr_other", action: "allow" }),
      ),
      model((m) => {
        expect(m.reviewing).toBe("apr_send");
        expect(m.dialog.isOpen).toBe(true);
      }),
      Command.resolve(
        DecideApproval({ bot: "hermes", approvalId: "apr_other", action: "allow" }),
        Message.ApprovalDecided({
          bot: "hermes",
          approvalId: "apr_other",
          status: "allowed",
          decidedAt: at,
        }),
      ),
    );
  });

  test("a decision for a bot with no channel is a no-op", () => {
    story(
      update,
      given(modelWith({ now: at })),
      message(Message.DecidedApproval({ bot: "hermes", approvalId: "apr_send", action: "allow" })),
      Command.expectNone(),
      model((m) => {
        expect(m.channels.hermes).toBeUndefined();
        expect(m.toast.entries).toHaveLength(0);
      }),
    );
  });

  test("an answer nobody reads retires itself", () => {
    story(
      update,
      given(modelWith()),
      message(Message.BotSaved({ id: "hermes", bot: rosterOf().bots.hermes })),
      // The stack schedules the entry's own dismissal timer, so a toast that
      // nobody clicks or hovers leaves on its own.
      drainToast(toastEntry(0)),
      model((m) => {
        expect(m.toast.entries).toHaveLength(0);
      }),
    );
  });

  test("an answer enters the stack, and a second answer stacks under it", () => {
    story(
      update,
      given(modelWith()),
      message(Message.BotSaved({ id: "hermes", bot: rosterOf().bots.hermes })),
      settleToast(toastEntry(0)),
      message(Message.BotSaveFailed({ bot: "hermes", error: "offline" })),
      settleToast(toastEntry(1)),
      model((m) => {
        // Neither answer replaced the other: the stack holds both, newest last.
        expect(m.toast.entries.map((entry) => entry.payload.text)).toEqual([
          "Saved Hermes.",
          "Couldn't save Hermes (offline).",
        ]);
        // The variant is what gives the entry its role: an answer that failed
        // is an alert, one that worked is a status.
        expect(m.toast.entries.map((entry) => entry.variant)).toEqual(["Success", "Error"]);
      }),
    );
  });
});
