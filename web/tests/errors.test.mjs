/*
 * The error paths against a real boundary, not assumed ones:
 *
 * - `/status` answers with a bot in its `errors` map, so the home has a bot it
 *   cannot show and must say so.
 * - `/transcript/scribe` fails, so a failed page must not blank the screen.
 * - Hermes' transcript pages, so the app's `before` request is exercised.
 */
import { Effect, Schema } from "effect";

import { BotViewSchema, TranscriptPageSchema } from "../../src/web-contract.ts";
import { HERMES_STATUS, HERMES_TRANSCRIPT, SCRIBE_STATUS } from "./fixture.mjs";
import { boot, makeChecker } from "./support/app.mjs";
import { pager, startStub } from "./support/stub.mjs";

const decode = (schema, label, value) =>
  Effect.runSync(
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.catch((cause) => {
        console.error(`fixture does not match ${label}: ${cause}`);
        return Effect.die(cause);
      }),
    ),
  );

for (const [bot, view] of Object.entries({ hermes: HERMES_STATUS, scribe: SCRIBE_STATUS })) {
  decode(BotViewSchema, `BotView(${bot})`, view);
}

// Fifty-two entries so the app's own `limit` (50) leaves an older page: ids
// 1..48 are filler, and the fixture's four entries keep their place at the tip.
const PAGE_SOURCE = [
  ...Array.from({ length: 48 }, (_, index) => ({
    id: index + 1,
    kind: "assistant",
    role: "assistant",
    text: `Earlier note ${index + 1}`,
    at: 1_792_000_000_000 + index * 60_000,
  })),
  ...HERMES_TRANSCRIPT.entries.map((entry, index) => ({ ...entry, id: 49 + index })),
];
decode(TranscriptPageSchema, "TranscriptPage(hermes, page 1)", {
  session: HERMES_TRANSCRIPT.session,
  stream: HERMES_TRANSCRIPT.stream,
  entries: PAGE_SOURCE.slice(2),
  nextBefore: 3,
});

const stub = startStub({
  status: {
    bots: { hermes: HERMES_STATUS, scribe: SCRIBE_STATUS },
    errors: { atlas: "status unavailable" },
  },
  transcripts: {
    hermes: pager({
      session: HERMES_TRANSCRIPT.session,
      stream: HERMES_TRANSCRIPT.stream,
      entries: PAGE_SOURCE,
    }),
  },
  failing: ["/transcript/scribe"],
});

const { check, finish } = makeChecker();
const app = await boot(stub.origin);
const { settle, query, all, text, display, waitFor, click } = app;

try {
  await waitFor(() => all(".doneitem").length === 1, "hermes' transcript loaded");

  check(
    "the home names the bot whose status failed",
    display('[data-group="error"]') !== "none" &&
      text('[data-group="error"] p') === "No status from Atlas.",
  );
  check(
    "the header still counts every known bot",
    text(".hdr.tall .hdr-sub") === "3 bots · 1 blocked · 1 running",
  );
  check("the blocked section still renders", display('[data-group="blocked"]') !== "none");
  check("the running section still renders", display('[data-group="running"]') !== "none");
  check("the failed status is not all-clear", display('[data-group="empty"]') === "none");
  check(
    "a failed transcript drops only that bot's recent row",
    all(".doneitem").length === 1 && text(".doneitem .rmeta").startsWith("Hermes"),
  );

  click(query(".ap-review"));
  await settle();
  const loaded = all("[data-entry]").length;
  check("the newest page of the paged transcript renders", loaded === 50, `${loaded}`);
  check("an older page is offered", query("[data-load]") !== null);

  click(query("[data-load]"));
  await waitFor(() => all("[data-entry]").length === 52, "the older page merged", 5_000);
  check("loading earlier prepends the older entries", all("[data-entry]").length === 52);
  check("the older entries are oldest first", text("[data-entry]").startsWith("Earlier note 1"));
  check("no older page remains", query("[data-load]") === null);

  const calls = stub.requests.map((request) => `${request.method} ${request.path}`);
  check(
    "the roster and each transcript were requested once",
    calls.filter((call) => call === "GET /status").length === 1 &&
      calls.includes("GET /transcript/hermes") &&
      calls.includes("GET /transcript/scribe"),
    calls.join("; "),
  );
  const paged = stub.requests.find(
    (request) => request.path === "/transcript/hermes" && request.query.before !== undefined,
  );
  check(
    "the older page was asked for with before and limit",
    paged !== undefined &&
      paged.method === "GET" &&
      paged.query.before === "3" &&
      paged.query.limit === "50",
    JSON.stringify(stub.requests),
  );
  check("no console errors", app.pageErrors.length === 0, app.pageErrors.join("; "));
} finally {
  stub.stop();
}

finish();
