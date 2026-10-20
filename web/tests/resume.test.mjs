/*
 * Reconnection carries the cursor.
 *
 * The stub's first connection emits three frames and closes without a `done`, so
 * the transport drops mid-stream. The app must not restart from zero: the
 * dependency record changes (`attempt`), which tears the stream down and opens a
 * fresh one whose `?from=` is the sequence number of the last frame it received.
 * The second connection holds, so exactly two connections prove resume rather
 * than a reconnect loop.
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
  at: 1,
  session: "hermes",
  entries: [],
  inbox: [],
  usage: { inputTokens: 0, outputTokens: 0, exchanges: 0 },
  transcriptFrom: 0,
};

const usage = (output) => ({
  kind: "usage",
  usage: { inputTokens: 0, outputTokens: output, exchanges: 1 },
});

for (const [label, frame] of [
  ["snapshot", snapshot],
  ["usage", usage(10)],
  ["usage", usage(20)],
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
    hermes: ({ index }) =>
      index === 0
        ? {
            frames: [
              { id: 0, data: snapshot },
              { id: 1, data: usage(10) },
              { id: 2, data: usage(20) },
            ],
          }
        : { frames: [{ event: "up-to-date", data: {} }], hold: true },
  },
});

const { check, finish } = makeChecker();
const app = await boot(stub.origin);
const { text, waitFor } = app;

const connections = () => stub.requests.filter((request) => request.path === "/events/hermes");

try {
  await waitFor(() => connections().length >= 2, "the dropped stream reconnected", 5_000);

  const [first, second] = connections();
  check(
    "the first connection starts at zero",
    first.query.from === "0",
    JSON.stringify(first.query),
  );
  check(
    "the reconnect resumes from the last sequence number it received",
    second.query.from === "2",
    JSON.stringify(second.query),
  );
  check(
    "the reconnect keeps the same stream and generation",
    second.query.stream === "feed:hermes:7" && second.query.gen === "7",
    JSON.stringify(second.query),
  );

  await new Promise((resolve) => setTimeout(resolve, 200));
  check(
    "the resumed connection holds instead of looping",
    connections().length === 2,
    `${connections().length}`,
  );
  check("the home still renders under the resumed stream", text(".hdr.tall h1") === "Needs you");
  check("no console errors", app.pageErrors.length === 0, app.pageErrors.join("; "));
} finally {
  stub.stop();
}

finish();
