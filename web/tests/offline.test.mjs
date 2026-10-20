/*
 * `/status` itself fails. The home must say the fleet was not reached rather
 * than render the all-clear or sit behind a spinner.
 */
import { boot, makeChecker } from "./support/app.mjs";
import { startStub } from "./support/stub.mjs";

const stub = startStub({ status: {}, transcripts: {}, failing: ["/status"] });

const { check, finish } = makeChecker();
const app = await boot(stub.origin);
const { all, text, display, waitFor } = app;

try {
  await waitFor(
    () => text('[data-group="error"] p').startsWith("Couldn't reach the fleet"),
    "the roster failure rendered",
  );

  check("the unreachable fleet is stated", display('[data-group="error"]') !== "none");
  check(
    "the notice says the fleet was not reached",
    text('[data-group="error"] p').startsWith("Couldn't reach the fleet"),
  );
  check(
    "the all-clear does not claim everything is fine",
    display('[data-group="empty"]') === "none",
  );
  check(
    "no bot sections are invented",
    all("[data-approval]").length === 0 && all(".doneitem").length === 0,
  );
  check(
    "the request was a GET of /status",
    stub.requests.length === 1 &&
      stub.requests[0].method === "GET" &&
      stub.requests[0].path === "/status",
    JSON.stringify(stub.requests),
  );
  check("no console errors", app.pageErrors.length === 0, app.pageErrors.join("; "));
} finally {
  stub.stop();
}

finish();
