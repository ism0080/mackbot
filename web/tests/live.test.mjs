/*
 * The live channel, end to end against a real event stream.
 *
 * The stub serves `text/event-stream` bytes: a snapshot and an approval frame,
 * an `up-to-date`, then a `done` and a close. The app connects because Hermes is
 * running and blocked on an approval, folds the approval frame into the same
 * channel `/status` wrote, and stops when the stream finishes. Scribe is idle,
 * so it must hold no connection at all.
 */
import { Effect, Schema } from "effect";

import { BotViewSchema, FrameSchema } from "../../src/web-contract.ts";
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
  entries: [
    {
      id: 45,
      kind: "assistant",
      role: "assistant",
      text: "The Botmail send is still waiting on you.",
      at: 1_792_145_000_000,
    },
  ],
  inbox: [],
  usage: { inputTokens: 12_500, outputTokens: 3_200, exchanges: 2 },
  transcriptFrom: 45,
};

const approval = {
  kind: "approval",
  approval: {
    approvalId: "apr_calendar",
    bot: "hermes",
    toolPath: "calendar.hold",
    summary: "Hold Thursday 09:00 for the renewal call?",
    status: "pending",
    requestedAt: 1_792_145_100_000,
  },
};

for (const [label, frame] of [
  ["snapshot", snapshot],
  ["approval", approval],
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
        { id: 1, data: approval },
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
  await waitFor(() => query('[data-approval="apr_calendar"]') !== null, "the approval frame arrived");

  check(
    "the Frame the stream carried is folded into the same channel",
    all("[data-approval]").length === 2 &&
      text('[data-approval="apr_calendar"] .ap-tool') === "calendar.hold",
  );
  check("the home counts the new approval", text(".hdr.tall .hdr-sub") === "2 bots · 2 blocked · 1 running");
  check("the run is still live", display('[data-group="running"]') !== "none");

  const hermesEvents = stub.requests.filter((request) => request.path === "/events/hermes");
  check("the blocked, running bot has exactly one connection", hermesEvents.length === 1, `${hermesEvents.length}`);
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
