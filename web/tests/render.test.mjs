/*
 * The triage home and transcripts, rendered by the built app from the real
 * routes.
 *
 * The app fetches over HTTP; the stub in `tests/support/stub.mjs` answers the
 * two documented routes with the recorded fixture payloads. The assertions are
 * the same interactions the desktop browser is the real verification for, plus
 * the requests the app made and the entries the stub returned.
 */
import { Effect, Schema } from "effect";

import { BotViewSchema, TranscriptPageSchema } from "@mackbot/contract";
import { FIXTURE_NOW, STATUS_RESPONSE, TRANSCRIPTS } from "./fixture.mjs";
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

for (const [bot, view] of Object.entries(STATUS_RESPONSE.bots)) {
  decode(BotViewSchema, `BotView(${bot})`, view);
}
for (const [bot, page] of Object.entries(TRANSCRIPTS)) {
  decode(TranscriptPageSchema, `TranscriptPage(${bot})`, page);
}

const stub = startStub({
  status: STATUS_RESPONSE,
  transcripts: {
    hermes: () => TRANSCRIPTS.hermes,
    scribe: () => TRANSCRIPTS.scribe,
  },
  decisions: {
    // The decision now has a server; this one confirms it, so "Allow retires the
    // approval everywhere" is still this test's subject rather than a rollback.
    "/approvals/hermes/apr_botmail_send": () => ({
      status: 200,
      body: {
        approvalId: "apr_botmail_send",
        bot: "hermes",
        status: "allowed",
        decidedAt: FIXTURE_NOW,
      },
    }),
  },
});

const { check, finish } = makeChecker();
const app = await boot(stub.origin);
const { settle, query, all, text, display, waitFor, click } = app;

try {
  await waitFor(() => all(".doneitem").length === 2, "both transcripts loaded");

  // 1 — the triage home renders all three sections from the stub's payloads.
  check("home has the tall header", text(".hdr.tall h1") === "Needs you");
  check(
    "header count matches the payloads",
    text(".hdr.tall .hdr-sub") === "2 bots · 1 blocked · 1 running",
  );
  check(
    "blocked section is shown and the all-clear is not",
    display('[data-group="blocked"]') !== "none" && display('[data-group="empty"]') === "none",
  );
  check("running section is shown", display('[data-group="running"]') !== "none");
  check("recent section is shown", display('[data-group="recent"]') !== "none");
  check("no error notice for a clean roster", display('[data-group="error"]') === "none");
  check("one approval card", all("[data-approval]").length === 1);
  check("approval names the tool", text(".ap-tool") === "botmail.send");
  check(
    "running row is derived from activeRun",
    text(".runit .rt") === "Reconciling March invoices",
  );
  check(
    "since-you-last-looked lists one entry per bot",
    all(".doneitem").length === 2 &&
      all(".doneitem .rt")
        .map((node) => node.textContent.trim())
        .join("|") === "Calendar hold moved to Thursday 10:00.|Q3 kickoff notes, 4 decisions",
  );

  // 2 — the draft preview expands on click.
  const draft = query("details.ap-draft");
  check("draft is closed", draft.open === false);
  check("draft body is in the DOM", query(".ap-draft pre").textContent.includes("Hi Dana,"));
  click(query(".ap-draft summary"));
  await settle();
  check("draft expands", draft.open === true);

  // 3 — the transcript is reachable from an item.
  const scribeRow = all(".doneitem").find((node) =>
    node.querySelector(".rmeta").textContent.startsWith("Scribe"),
  );
  click(scribeRow);
  await settle();
  check("transcript opens", text(".hdr h1") === "Scribe");
  check("transcript renders the model label", text(".hdr .hdr-sub") === "longcat-2.5-preview-free");
  check("transcript renders session entries", all("[data-entry]").length === 3);
  check("transcript shows no approval reference for scribe", all(".ap-ref").length === 0);
  check("no load-earlier control on a complete page", query("[data-load]") === null);
  click(query(".icon"));
  await settle();
  check("back returns to the home", text(".hdr.tall h1") === "Needs you");

  // 4 — the approval is reachable from the home and the transcript shows it too.
  click(query(".ap-review"));
  await settle();
  check("review opens the owning bot's transcript", text(".hdr h1") === "Hermes");
  check("transcript references the pending approval", all(".ap-ref").length === 1);
  check("transcript shows the in-flight run", text(".live").includes("Reconciling March invoices"));
  check(
    "a cron entry with no timestamp renders the origin with no clock",
    all(".origin")
      .map((node) => node.textContent.trim())
      .join("|") === "cron",
  );
  click(query(".icon"));
  await settle();

  // 5 — Allow retires the approval everywhere at once.
  click(query(".btn.primary"));
  await settle();
  check(
    "headline names the fault the approval did not clear",
    text(".hdr.tall h1") === "Needs attention",
  );
  check(
    "header count drops the blocked one",
    text(".hdr.tall .hdr-sub") === "2 bots · 0 blocked · 1 running",
  );
  check("blocked section collapses", display('[data-group="blocked"]') === "none");
  check(
    "the all-clear block stays hidden while a fault stands",
    display('[data-group="empty"]') === "none",
  );
  check("the fault is still listed", all("[data-failure]").length === 1);
  check("no approval card remains", all("[data-approval]").length === 0);
  check("running section survives", text(".runit .rt") === "Reconciling March invoices");

  click(query(".doneitem"));
  await settle();
  check("transcript for the approved bot opens", text(".hdr h1") === "Hermes");
  check("approval reference is gone from the transcript", all(".ap-ref").length === 0);

  // 6 — the requests the app made.
  const firstCalls = stub.requests
    .filter(
      (request, index) => stub.requests.findIndex((other) => other.path === request.path) === index,
    )
    .map((request) => `${request.method} ${request.path}`);
  check(
    "the app asked for the roster, both transcripts, the live bot's events, and the decision",
    firstCalls.length === 5 &&
      firstCalls[0] === "GET /status" &&
      firstCalls.slice(1).sort().join("|") ===
        "GET /events/hermes|GET /transcript/hermes|GET /transcript/scribe|POST /approvals/hermes/apr_botmail_send",
    firstCalls.join("; "),
  );
  const transcriptQueries = stub.requests
    .filter((request) => request.path.startsWith("/transcript/"))
    .map((request) => request.query);
  check(
    "each transcript request carries the limit the app asked for",
    transcriptQueries.length === 2 &&
      transcriptQueries.every((query) => query.limit === "50" && query.before === undefined),
    JSON.stringify(transcriptQueries),
  );

  check("no console errors", app.pageErrors.length === 0, app.pageErrors.join("; "));
} finally {
  stub.stop();
}

finish();
