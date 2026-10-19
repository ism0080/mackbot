/*
 * The status panel on the home: what the harness reported and what it still
 * has live.
 *
 * The stub answers `/status` with the recorded fixture payloads, so the panel
 * is exercised against the same data the rest of the app decodes. Hermes
 * carries one failure and one live task; Scribe carries neither, so it
 * contributes no row to either section.
 *
 * The home polls every five seconds, and the poll answers without the two
 * optional lists, so the sections have to collapse once nothing is left to
 * say — which is the "a bot with neither renders neither section" case.
 */
import { Effect, Schema } from "effect";

import { BotViewSchema } from "../../src/web-contract.ts";
import { HERMES_STATUS, SCRIBE_STATUS, STATUS_RESPONSE, TRANSCRIPTS } from "./fixture.mjs";
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

// The two lists are optional on the contract, so a bot that never had them
// is a bot with nothing to report.
const { failures: _failures, tasks: _tasks, ...quietHermes } = HERMES_STATUS;
decode(BotViewSchema, "BotView(hermes, quiet)", quietHermes);

const stub = startStub({
  // The stub records a request before it answers it, so the first `/status`
  // here is the app's init command and every later one is the home's poll.
  status: () => {
    const served = stub.requests.filter((request) => request.path === "/status").length;
    return served === 1
      ? STATUS_RESPONSE
      : { bots: { hermes: quietHermes, scribe: SCRIBE_STATUS }, errors: {} };
  },
  transcripts: {
    hermes: () => TRANSCRIPTS.hermes,
    scribe: () => TRANSCRIPTS.scribe,
  },
});

const { check, finish } = makeChecker();
const app = await boot(stub.origin);
const { all, text, display, waitFor } = app;

try {
  await waitFor(() => all(".doneitem").length === 2, "both transcripts loaded");
  await waitFor(() => all("[data-failure]").length === 1, "the failure row rendered");

  // 1 — the failure is shown with the harness's own words.
  check("the failures section is shown", display('[data-group="failures"]') !== "none");
  check("the section is named", text('[data-group="failures"] h2') === "Needs attention");
  check("one failure row", all("[data-failure]").length === 1);
  check("the failure names the error", text(".sp-fail .rt") === "TypeError");
  check(
    "the failure carries the detail",
    text(".sp-fail .sp-detail") === "Cannot read properties of undefined (reading 'amount')",
    text(".sp-fail .sp-detail"),
  );
  check(
    "the failure says when it was reported and whose it is",
    /^reported \S+ · Hermes$/.test(text(".sp-fail .sp-foot")),
    text(".sp-fail .sp-foot"),
  );

  // 2 — the live task is shown with its kind, its status and its phase.
  check("the live work section is shown", display('[data-group="tasks"]') !== "none");
  check("the section is named", text('[data-group="tasks"] h2') === "Live work");
  check("one task row", all("[data-task]").length === 1);
  check("the task names its kind", text(".sp-task .rt") === "reconcile");
  check("the task shows its status", text(".sp-task .tag") === "running");
  check(
    "the task shows its phase",
    text(".sp-task .rmeta") === "matching March invoices against the ledger",
    text(".sp-task .rmeta"),
  );
  check("the task says whose it is", text(".sp-task .sp-foot") === "Hermes");

  // 3 — the two sections sit in the order the home reads.
  const groups = all("[data-group]").map((node) => node.getAttribute("data-group"));
  check(
    "the failure section comes before the live work section",
    groups.indexOf("failures") !== -1 &&
      groups.indexOf("tasks") !== -1 &&
      groups.indexOf("failures") < groups.indexOf("tasks"),
    groups.join("|"),
  );

  // 4 — a bot with neither contributes no row to either section.
  check(
    "the quiet bot has no row in either section",
    all(".sp-fail[data-bot='scribe']").length === 0 && all(".sp-task[data-bot='scribe']").length === 0,
    all(".sp-fail, .sp-task").map((node) => node.getAttribute("data-bot")).join("|"),
  );

  // 5 — the poll answers without the two lists, and both sections collapse.
  const collapsed = await waitFor(
    () => display('[data-group="failures"]') === "none" && display('[data-group="tasks"]') === "none",
    "the empty sections collapse",
    9_000,
  );
  check("the sections collapse once nothing is left to say", collapsed);
  check("the rows are gone with them", all("[data-failure]").length === 0 && all("[data-task]").length === 0);

  check("no console errors", app.pageErrors.length === 0, app.pageErrors.join("; "));
} finally {
  stub.stop();
}

finish();
