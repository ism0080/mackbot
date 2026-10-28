/**
 * Smoke test for the approvals store (src/approvals.ts) and the status
 * projection (src/status.ts).
 *
 * Run with: bun tests/status.smoke.mjs
 *
 * The claims this file has to break if they stop holding:
 *   1. An approval recorded as pending is what `/status` reports as pending;
 *      a decided one is not.
 *   2. The active run is a view the caller derived from pi's own live state, and
 *      the projection carries it through unchanged — including its stream cursor
 *      and its prompt — or omits it when the bot is idle.
 *   3. Usage reaches the client as the view the contract defines, not as pi's
 *      ledger.
 */
import { Database } from "bun:sqlite";
import { sqliteStorage } from "./support/sqlite.mjs";

const { createApprovalStore } = await import("../src/approvals.ts");
const { projectStatus } = await import("../src/status.ts");

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
};

const fresh = () => {
  const database = new Database(":memory:");
  return { database, approvals: createApprovalStore(sqliteStorage(database)) };
};

const approval = (overrides) => ({
  approvalId: "apr-1",
  bot: "hermes",
  thread: "invoices",
  toolPath: "botmail.send",
  summary: "Send the drafted reply?",
  artifact: { label: "Draft", body: "Hi Dana," },
  status: "pending",
  requestedAt: 1_000,
  ...overrides,
});

// ---------------------------------------------------------------------------
// The store: pending rows survive the round trip; decided ones are not pending.
// ---------------------------------------------------------------------------

{
  const { approvals } = fresh();
  approvals.record(approval({}));
  approvals.record(approval({ approvalId: "apr-2", status: "allowed", requestedAt: 500 }));
  const pending = approvals.pending();
  check("only the pending approval is listed", pending.length === 1, `${pending.length}`);
  check("the approval id round-trips", pending[0]?.approvalId === "apr-1", pending[0]?.approvalId);
  check("the bot round-trips", pending[0]?.bot === "hermes");
  check("the thread round-trips", pending[0]?.thread === "invoices");
  check("the tool path round-trips", pending[0]?.toolPath === "botmail.send");
  check("the artifact round-trips", pending[0]?.artifact?.body === "Hi Dana,");
  check(
    "the request time round-trips",
    pending[0]?.requestedAt === 1_000,
    `${pending[0]?.requestedAt}`,
  );
  check("an undecided row has no decision time", pending[0]?.decidedAt === undefined);

  approvals.record(approval({}));
  check("recording the same approval twice is idempotent", approvals.pending().length === 1);
}

{
  const { approvals } = fresh();
  approvals.record(approval({ approvalId: "later", requestedAt: 900 }));
  approvals.record(approval({ approvalId: "earlier", requestedAt: 100 }));
  const order = approvals
    .pending()
    .map((row) => row.approvalId)
    .join(",");
  check("the longest-waiting approval is first", order === "earlier,later", order);
}

// ---------------------------------------------------------------------------
// The projection: the home screen's two facts come out of `/status`.
// ---------------------------------------------------------------------------

const activeRun = {
  ordinal: 1,
  inputs: ["reconcile the invoices"],
  startedAt: 1_000,
  session: "1",
  stream: { stream: "feed:1:1", generation: 1, cursor: 7, state: "streaming" },
};

const facts = (overrides) => ({
  id: "hermes",
  model: { provider: "opencode-go", id: "deepseek-v4-pro" },
  thinkingLevel: "high",
  busy: true,
  pending: [],
  usage: { models: {}, tools: {} },
  approvals: [],
  activeRun,
  ...overrides,
});

{
  const { approvals } = fresh();
  approvals.record(approval({}));
  const view = projectStatus(
    facts({
      approvals: approvals.pending(),
      pending: [{ operationId: "http:a", origin: "http", status: "running" }],
      usage: {
        models: {
          "opencode-go/x": {
            input: 10,
            output: 4,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 14,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
        tools: {},
      },
    }),
  );

  check(
    "the status view reports the pending approval",
    view.approvals.length === 1 && view.approvals[0].status === "pending",
    JSON.stringify(view.approvals.map((a) => a.status)),
  );
  check("the status view reports the active run", view.activeRun?.ordinal === 1);
  check(
    "the active run carries its inputs",
    view.activeRun?.inputs[0] === "reconcile the invoices",
  );
  check(
    "the active run names its stream",
    view.activeRun?.stream.stream === "feed:1:1",
    view.activeRun?.stream.stream,
  );
  check("the active run's stream is streaming", view.activeRun?.stream.state === "streaming");
  check(
    "the active run's stream carries the cursor",
    view.activeRun?.stream.cursor === 7,
    `${view.activeRun?.stream.cursor}`,
  );
  check(
    "the active run carries pi's start time",
    view.activeRun?.startedAt === 1_000,
    `${view.activeRun?.startedAt}`,
  );
  check(
    "usage is projected, not raw",
    view.usage.inputTokens === 10 && view.usage.exchanges === 1,
    JSON.stringify(view.usage),
  );
}

{
  const view = projectStatus(facts({ activeRun: undefined, busy: false }));
  check("an idle bot has no active run", view.activeRun === undefined);
  check("an idle bot reports empty approvals", view.approvals.length === 0);
  check("an idle bot is not busy", view.busy === false);
}

if (failures.length > 0) {
  console.error("status smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("status smoke passed");
process.exit(0);
