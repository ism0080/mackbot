/*
 * A deep link into a chat, through the built app over real HTTP.
 *
 * The URL is the screen: loading `/chat/scribe` must open Scribe's transcript,
 * not the home, and must load that transcript without a prior home visit. This
 * is the reload case a person hits after refreshing the page.
 */
import { STATUS_RESPONSE, TRANSCRIPTS } from "./fixture.mjs";
import { boot, makeChecker } from "./support/app.mjs";
import { startStub } from "./support/stub.mjs";

const stub = startStub({
  status: STATUS_RESPONSE,
  transcripts: {
    hermes: () => TRANSCRIPTS.hermes,
    scribe: () => TRANSCRIPTS.scribe,
  },
});

const { check, finish } = makeChecker();
const app = await boot(stub.origin, "/chat/scribe");
const { all, query, text, waitFor } = app;

try {
  await waitFor(() => all("[data-entry]").length === 3, "the deep-linked transcript rendered");

  check("the URL stays on the chat", app.window.location.pathname === "/chat/scribe");
  check("the transcript is the screen", text(".hdr h1") === "Scribe");
  check("the home was not shown", query(".hdr.tall") === null);
  check("the transcript's entries are there", all("[data-entry]").length === 3);
  check("the composer is there", query('[data-field="chat"]') !== null);
  check(
    "the deep-linked transcript was fetched directly",
    stub.requests.some(
      (request) => request.method === "GET" && request.path === "/transcript/scribe",
    ),
    stub.requests.map((request) => `${request.method} ${request.path}`).join("; "),
  );
  check("no console errors", app.pageErrors.length === 0, app.pageErrors.join("; "));
} finally {
  stub.stop();
}

finish();
