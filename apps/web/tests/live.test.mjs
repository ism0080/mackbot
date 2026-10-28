/*
 * The live channel, end to end against a real event stream.
 *
 * The stub serves `text/event-stream` bytes: a snapshot, a `task_failed` frame,
 * an `up-to-date`, then a `done` and a close. The app connects because Hermes is
 * running and blocked on an approval, folds the failed task into the same
 * channel `/status` wrote (which clears the run), and stops when the stream
 * finishes. Scribe is idle, so it must hold no connection at all.
 *
 * Approvals are status payloads, not frames: the pending one the home shows is
 * read from `/status`, and the stream only changes what pi commits during a run.
 */
import { Effect, Schema } from "effect";

import { BotViewSchema, FrameSchema } from "@mackbot/contract";
import { HERMES_STATUS, HERMES_TRANSCRIPT, SCRIBE_STATUS, SCRIBE_TRANSCRIPT } from "./fixture.mjs";
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

for (const [bot, view] of Object.entries({ hermes: HERMES_STATUS, scribe: SCRIBE_STATUS })) {
  decode(BotViewSchema, `BotView(${bot})`, view);
}

const snapshot = {
  kind: "snapshot",
  generation: 7,
  at: 1_792_145_000_000,
  session: "hermes",
  entries: [],
  live: { tools: [], compactions: [] },
  inbox: [],
  usage: { inputTokens: 12_500, outputTokens: 3_200, exchanges: 2 },
  transcriptFrom: 0,
};

const failed = {
  kind: "task_failed",
  taskId: "task_invoice_ledger",
  task: "reconcile",
  message: "the ledger read failed",
};

for (const [label, frame] of [
  ["snapshot", snapshot],
  ["task_failed", failed],
]) {
  decode(FrameSchema, `Frame(${label})`, frame);
}

const stub = startStub({
  status: { bots: { hermes: HERMES_STATUS, scribe: SCRIBE_STATUS }, errors: {} },
  transcripts: {
    hermes: () => HERMES_TRANSCRIPT,
    scribe: () => SCRIBE_TRANSCRIPT,
  },
  events: {
    hermes: () => ({
      frames: [
        { id: 0, data: snapshot },
        { id: 1, data: failed },
        { event: "up-to-date", data: {} },
        { event: "done", data: {} },
      ],
    }),
  },
});

const { check, finish } = makeChecker();
const app = await boot(stub.origin);
const { query, all, text, display, waitFor } = app;

try {
  await waitFor(
    () => query('[data-approval="apr_botmail_send"]') !== null,
    "the status approval is on screen",
  );

  check(
    "the pending approval comes from /status, once",
    all("[data-approval]").length === 1,
    `${all("[data-approval]").length}`,
  );
  check(
    "the approval names the tool it is gated on",
    text('[data-approval="apr_botmail_send"] .ap-tool') === "botmail.send",
  );

  await waitFor(
    () => display('[data-group="running"]') === "none",
    "the failed task ended the run",
  );
  check("a failed task clears the run", display('[data-group="running"]') === "none");

  const hermesEvents = stub.requests.filter((request) => request.path === "/events/hermes");
  check(
    "the blocked, running bot has exactly one connection",
    hermesEvents.length === 1,
    `${hermesEvents.length}`,
  );
  const first = hermesEvents[0];
  check(
    "the connection names the status row's stream and generation, from the start",
    first.query.stream === "feed:hermes:7" && first.query.gen === "7" && first.query.from === "0",
    JSON.stringify(first.query),
  );
  check(
    "the idle bot holds no connection",
    stub.requests.filter((request) => request.path === "/events/scribe").length === 0,
  );
  check("up-to-date changed nothing the home shows", text(".hdr.tall h1") === "Needs you");
  check("no console errors", app.pageErrors.length === 0, app.pageErrors.join("; "));
} finally {
  stub.stop();
}

finish();
