/*
 * The poll repeats, and its lifetime is the screen.
 *
 * One idle bot keeps SSE out of the picture, so every `/status` request here is
 * the poll. The test counts requests over a window, then changes the screen: the
 * home's 5s cadence must stop, and a transcript's 10s cadence must not have
 * fired within the window that follows. If the old scope were not torn down, a
 * 5s tick would land inside it and the count would rise.
 */
import { boot, makeChecker } from "./support/app.mjs";
import { startStub } from "./support/stub.mjs";
import { SCRIBE_STATUS, SCRIBE_TRANSCRIPT } from "./fixture.mjs";

const stubbed = {
  id: SCRIBE_STATUS.id,
  ...SCRIBE_STATUS,
  busy: false,
  pending: [],
  approvals: [],
};

const stub = startStub({
  status: { bots: { scribe: stubbed }, errors: {} },
  transcripts: { scribe: () => SCRIBE_TRANSCRIPT },
});

const { check, finish } = makeChecker();
const app = await boot(stub.origin);
const { query, text, waitFor, click, settle } = app;

const statusCount = () =>
  stub.requests.filter((request) => request.path === "/status").length;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  await waitFor(() => query(".doneitem") !== null, "the home rendered");
  const before = statusCount();
  check("the first status request is the init Command", before === 1, `${before}`);

  await sleep(5_600);
  const polled = statusCount();
  check("the home poll repeats inside a five-second window", polled >= 2, `${polled}`);

  click(query(".doneitem"));
  await settle();
  check("a transcript opened", text(".hdr h1") === "Scribe");
  const atSwitch = statusCount();

  await sleep(6_500);
  const afterSwitch = statusCount();
  check(
    "the home's five-second cadence stopped with its screen",
    afterSwitch === atSwitch,
    `before ${atSwitch}, after ${afterSwitch}`,
  );
  check("no console errors", app.pageErrors.length === 0, app.pageErrors.join("; "));
} finally {
  stub.stop();
}

finish();
