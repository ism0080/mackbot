/*
 * Deciding an approval, end to end against a real boundary.
 *
 * The stub answers `POST /approvals/:bot/:approvalId` three different ways, and
 * projects whatever it recorded back through `/status`, so one booted app shows
 * all three outcomes:
 *
 * - `apr_ok` succeeds, slowly enough that the optimistic flip is observable
 *   before the answer lands.
 * - `apr_fail` answers `500`, so the optimistic flip was wrong and the screen
 *   has to take it back and say so.
 * - `apr_taken` answers `409` (`{ error }`) because another decider got there
 *   first; the app must keep the approval retired, say so, and refetch the
 *   status that owns the surviving state.
 *
 * The transcript's waiting row is derived from the same pending set, so it is
 * checked once the three outcomes have settled.
 */
import { Effect, Schema } from "effect";

import { BotViewSchema } from "@mackbot/contract";
import { FIXTURE_NOW, HERMES_STATUS, HERMES_TRANSCRIPT } from "./fixture.mjs";
import { boot, makeChecker } from "./support/app.mjs";
import { startStub } from "./support/stub.mjs";

const decode = (schema, label, value) =>
  Effect.runSync(
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.catch((cause) => {
        console.error(`fixture does not match ${label}: ${cause}`);
        return Effect.die(cause);
      }),
    ),
  );

/** The decision route's own accepted body, as `web/src/api.ts` decodes it. */
const AcceptedSchema = Schema.Struct({
  approvalId: Schema.String,
  bot: Schema.String,
  status: Schema.Literals(["allowed", "denied"]),
  decidedAt: Schema.Number,
});

const accepted = (approvalId, status) => ({
  approvalId,
  bot: "hermes",
  status,
  decidedAt: FIXTURE_NOW,
});

const at = (minutesAgo) => FIXTURE_NOW - minutesAgo * 60_000;

const APPROVALS = {
  apr_ok: {
    approvalId: "apr_ok",
    bot: "hermes",
    toolPath: "botmail.send",
    summary: "Send the renewal reply?",
    status: "pending",
    requestedAt: at(4),
  },
  apr_fail: {
    approvalId: "apr_fail",
    bot: "hermes",
    toolPath: "calendar.hold",
    summary: "Hold Thursday 09:00?",
    status: "pending",
    requestedAt: at(3),
  },
  apr_taken: {
    approvalId: "apr_taken",
    bot: "hermes",
    toolPath: "drive.trash",
    summary: "Delete the old drafts?",
    status: "pending",
    requestedAt: at(2),
  },
};

const hermes = { ...HERMES_STATUS, approvals: Object.values(APPROVALS) };
decode(BotViewSchema, "BotView(hermes)", hermes);
decode(AcceptedSchema, "Accepted(apr_ok)", accepted("apr_ok", "allowed"));

/** What the stub has recorded, projected the way `/status` would. */
const recorded = {};
const statusView = () => ({
  bots: {
    hermes: {
      ...hermes,
      approvals: Object.values(APPROVALS).map((approval) =>
        recorded[approval.approvalId] === undefined
          ? approval
          : { ...approval, status: recorded[approval.approvalId], decidedAt: FIXTURE_NOW },
      ),
    },
  },
  errors: {},
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const stub = startStub({
  status: statusView,
  transcripts: { hermes: () => HERMES_TRANSCRIPT },
  decisions: {
    "/approvals/hermes/apr_ok": async () => {
      await sleep(250);
      recorded.apr_ok = "allowed";
      return { status: 200, body: accepted("apr_ok", "allowed") };
    },
    "/approvals/hermes/apr_fail": async () => {
      await sleep(250);
      return { status: 500, body: { error: "the reservation was rejected" } };
    },
    "/approvals/hermes/apr_taken": async () => {
      await sleep(250);
      recorded.apr_taken = "denied";
      return { status: 409, body: { error: "no pending approval" } };
    },
  },
});

const { check, finish } = makeChecker();
const app = await boot(stub.origin);
const { settle, query, all, text, waitFor, click } = app;

const card = (id) => query(`[data-approval="${id}"]`);
const cards = () => all("[data-approval]").length;
const decisionCalls = () =>
  stub.requests.filter((request) => request.path.startsWith("/approvals/"));
const statusCalls = () => stub.requests.filter((request) => request.path === "/status").length;

try {
  await waitFor(() => cards() === 3, "hermes' three approvals rendered");

  // 1 — a success: the flip is immediate, the answer keeps it, nothing is said.
  click(query('[data-approval="apr_ok"] .btn.primary'));
  await settle();
  check("the approval retires optimistically", card("apr_ok") === null && cards() === 2);
  await waitFor(() => decisionCalls().length === 1, "the decision reached the stub");
  await sleep(300);
  check("the recorded success keeps it retired", card("apr_ok") === null);
  check("a recorded decision leaves nothing to say", query("[data-toast]") === null);

  // 2 — a failure: the flip was wrong, so the card and its buttons come back.
  click(query('[data-approval="apr_fail"] .btn.primary'));
  await settle();
  check(
    "the failing decision also retires optimistically",
    card("apr_fail") === null && cards() === 1,
  );
  await waitFor(() => card("apr_fail") !== null, "the failed decision is rolled back");
  check(
    "the card is back with its buttons",
    query('[data-approval="apr_fail"] .btn.primary') !== null,
  );
  check(
    "the screen says the decision did not stick",
    text("[data-toast]").includes("Couldn't record that decision"),
    text("[data-toast]"),
  );
  click(query("[data-toast]"));
  await settle();
  check("the notice can be dismissed", query("[data-toast]") === null);

  // 3 — a refusal: another decider won, so the card stays retired and the app
  // refetches the status that owns the surviving state.
  const statusBefore = statusCalls();
  click(query('[data-approval="apr_taken"] .btn.ghost'));
  await settle();
  check(
    "the refused decision retires optimistically too",
    card("apr_taken") === null && cards() === 1,
  );
  await waitFor(
    () =>
      query("[data-toast]") !== null && text("[data-toast]").includes("already decided elsewhere"),
    "the refusal is reported",
  );
  await waitFor(() => statusCalls() > statusBefore, "the refusal refetched /status");
  check("the refused card does not come back", card("apr_taken") === null);

  // 4 — the transcript's waiting row follows the same pending set.
  click(query('[data-approval="apr_fail"] .ap-review'));
  await settle();
  check(
    "only the still-pending approval keeps a waiting row",
    all(".ap-ref").length === 1 && query(".ap-ref").getAttribute("data-approval") === "apr_fail",
    all(".ap-ref")
      .map((node) => node.getAttribute("data-approval"))
      .join("|"),
  );

  // 5 — the requests the app actually made.
  const calls = decisionCalls();
  check(
    "each decision is one POST to the bot's approval path",
    calls.length === 3 && calls.every((request) => request.method === "POST"),
    calls.map((request) => `${request.method} ${request.path}`).join("; "),
  );
  check(
    "the allow body carries the contract's action",
    calls.find((request) => request.path === "/approvals/hermes/apr_ok")?.body?.action === "allow",
    JSON.stringify(calls.find((request) => request.path === "/approvals/hermes/apr_ok")?.body),
  );
  check(
    "the deny body carries the contract's action",
    calls.find((request) => request.path === "/approvals/hermes/apr_taken")?.body?.action ===
      "deny",
    JSON.stringify(calls.find((request) => request.path === "/approvals/hermes/apr_taken")?.body),
  );

  check("no console errors", app.pageErrors.length === 0, app.pageErrors.join("; "));
} finally {
  stub.stop();
}

finish();
