/*
 * Stopping a bot from the home: the Stop button on the running row.
 *
 * The stub answers `POST /abort/:bot` with the contract's abort result, so the
 * app hits a real HTTP boundary and the test can assert the method, the path
 * and the body the app actually sent. The CSRF header is the same one the
 * decision route requires.
 */
import { startStub } from "./support/stub.mjs";
import { boot, makeChecker } from "./support/app.mjs";
import { STATUS_RESPONSE, TRANSCRIPTS } from "./fixture.mjs";

const stops = [];

const stub = startStub({
  status: STATUS_RESPONSE,
  transcripts: {
    hermes: () => TRANSCRIPTS.hermes,
    scribe: () => TRANSCRIPTS.scribe,
  },
  aborts: {
    "/abort/hermes": ({ body }) => {
      stops.push(body);
      return { status: 200, body: { bot: "hermes", session: body.session, aborted: true } };
    },
  },
});

const { check, finish } = makeChecker();
const app = await boot(stub.origin);
const { all, text, query, click, waitFor, settle } = app;

try {
  await waitFor(() => all("[data-stop]").length === 1, "the stop button rendered");

  check("the running row carries the stop button", all("[data-stop]").length === 1);
  check("the button names the bot", all("[data-stop]")[0].getAttribute("data-stop") === "hermes");

  click(query("[data-stop]"));
  await settle();

  const stop = stub.requests.find((request) => request.path === "/abort/hermes");
  check("the app posted to the abort route", stop !== undefined, JSON.stringify(stub.requests));
  check("it posted", stop?.method === "POST", stop?.method);
  check(
    "it named the session the run belongs to",
    stop?.body?.session === "1",
    JSON.stringify(stop?.body),
  );
  check("the server saw one stop", stops.length === 1, `${stops.length}`);
  check(
    "the toast says the bot stopped",
    text(".toast").includes("Stopped Hermes"),
    text(".toast"),
  );

  // The status is read again, because the run that just stopped is gone from
  // the server's view of the world.
  const statuses = stub.requests.filter((request) => request.path === "/status");
  check("the status was read again", statuses.length >= 2, `${statuses.length}`);
} finally {
  finish();
  stub.stop();
}
