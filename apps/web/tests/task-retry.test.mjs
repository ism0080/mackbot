/*
 * Running a parked task again: the Retry button on the parked row.
 *
 * The stub answers `POST /retry/:bot` with the contract's retry result, so the
 * app hits a real HTTP boundary and the test can assert the method, the path,
 * the body and the CSRF header the app actually sent. Hermes carries one
 * parked task; Scribe carries neither a failure nor a task, so it contributes
 * no row to the parked section.
 */
import { startStub } from "./support/stub.mjs";
import { boot, makeChecker } from "./support/app.mjs";
import { STATUS_RESPONSE, TRANSCRIPTS } from "./fixture.mjs";

const retries = [];

const stub = startStub({
  status: STATUS_RESPONSE,
  transcripts: {
    hermes: () => TRANSCRIPTS.hermes,
    scribe: () => TRANSCRIPTS.scribe,
  },
  retries: {
    "/retry/hermes": ({ body }) => {
      retries.push(body);
      return { status: 200, body: { bot: "hermes", taskId: body.taskId, retried: true } };
    },
  },
});

const { check, finish } = makeChecker();
const app = await boot(stub.origin);
const { all, text, query, click, waitFor, settle, display } = app;

try {
  await waitFor(() => all("[data-parked]").length === 1, "the parked task rendered");

  // 1 — the parked task is listed, with the harness's own words for it.
  check("the parked section is shown", display('[data-group="parked"]') !== "none");
  check("the section is named", text('[data-group="parked"] h2') === "Parked");
  check("one parked task", all("[data-parked]").length === 1);
  check("the task names its kind", text(".sp-parked .rt") === "payroll", text(".sp-parked .rt"));
  check(
    "the task shows the harness's reason",
    text(".sp-parked .sp-reason") === "restart_limit",
    text(".sp-parked .sp-reason"),
  );
  check("the task says whose it is", text(".sp-parked .sp-foot") === "Hermes");

  // 2 — a bot with nothing parked contributes no row.
  check(
    "the quiet bot contributes no parked row",
    all(".sp-parked[data-bot='scribe']").length === 0,
    all(".sp-parked")
      .map((node) => node.getAttribute("data-bot"))
      .join("|"),
  );

  // 3 — the Retry button posts to the route with the task's id.
  check("the parked task carries a retry button", all("[data-retry]").length === 1);
  click(query("[data-retry]"));
  await waitFor(() => text(".toast").length > 0, "the toast appeared");

  const retry = stub.requests.find((request) => request.path === "/retry/hermes");
  check("the app posted to the retry route", retry !== undefined, JSON.stringify(stub.requests));
  check("it posted", retry?.method === "POST", retry?.method);
  check(
    "it named the task to run again",
    retry?.body?.taskId === "task_payroll_run",
    JSON.stringify(retry?.body),
  );
  check(
    "it carried the CSRF header the server requires",
    retry?.headers?.["x-mackbot-csrf"] === "1",
    JSON.stringify(retry?.headers),
  );
  check("the server saw one retry", retries.length === 1, `${retries.length}`);

  // 4 — the toast says what happened.
  check(
    "the toast says the task ran again",
    text(".toast").includes("Reran Hermes"),
    text(".toast"),
  );

  // 5 — the status is read again, because the task that just ran is no longer
  // parked in the server's view of the world.
  const statuses = stub.requests.filter((request) => request.path === "/status");
  check("the status was read again", statuses.length >= 2, `${statuses.length}`);

  check("no console errors", app.pageErrors.length === 0, app.pageErrors.join("; "));
} finally {
  settle();
  finish();
  stub.stop();
}
