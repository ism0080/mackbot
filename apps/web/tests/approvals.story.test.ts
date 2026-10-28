import { AsyncData } from "foldkit";
import { Command, given, message, model, story } from "foldkit/story";
import { describe, expect, test } from "vitest";

import { DecideApproval, Status } from "../src/api.ts";
import { Message } from "../src/message.ts";
import type { Model } from "../src/model.ts";
import { update } from "../src/update.ts";
import { FIXTURE_NOW, approvalOf, modelWith, statusOf } from "./support/fixtures.ts";
import { botChannel, statusIn } from "./support/story.ts";

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

        // The optimistic flip stamps the client's clock on the decided card.
        expect(decided.decidedAt).toBe(at);
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
      Command.expectNone(),
      model((m) => {
        const approval = approvalIn(m, "apr_send");
        expect(approval.status).toBe("pending");
        expect(approval.decidedAt).toBeUndefined();
        expect(m.toast?.text).toBe("Couldn't record that decision (boom). Try again.");
      }),
    );
  });

  test("ApprovalRefused keeps the retired approval and refetches the status", () => {
    // The local flip already took this approval out of the pending set; the 409
    // does not name a winning state, so the refusal only asks for fresh status.
    const seededRefused = {
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
      given(seededRefused),
      message(Message.ApprovalRefused({ bot: "hermes", approvalId: "apr_send" })),
      Command.expectExact(Status),
      model((m) => {
        expect(m.toast?.text).toBe("That approval was already decided elsewhere.");
        expect(approvalIn(m, "apr_send").status).toBe("allowed");
      }),
      Command.resolve(Status, Message.StatusFailed({ error: "offline", at })),
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
        expect(m.toast).toBeNull();
      }),
    );
  });

  test("DismissedToast clears the toast", () => {
    story(
      update,
      given(modelWith({ toast: { text: "something to dismiss" } })),
      message(Message.DismissedToast()),
      Command.expectNone(),
      model((m) => {
        expect(m.toast).toBeNull();
      }),
    );
  });
});
