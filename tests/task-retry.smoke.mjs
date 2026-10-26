/**
 * Smoke test for the parked-task projection (src/task-retry.ts) and for the
 * crash-loop guard it reads (src/runtime-policy.ts).
 *
 * Run with: bun tests/task-retry.smoke.mjs
 *
 * The claims this file has to break if they stop holding:
 *   1. A task the harness parked — blocked with the reason `restart_limit` —
 *      is the only one the projection offers to run again.
 *   2. A task blocked for any other reason is not parked, and neither is a
 *      task that is running, waiting or sleeping.
 *   3. The parked tasks come back in numeric task id order, so two polls of
 *      the same state agree.
 *   4. The policy a bot runs under carries the restart limit, and a bot that
 *      declares one gets it instead of the default.
 *
 * The inspections are plain objects: this file proves the projection and the
 * policy, not the harness.
 */

const { parkedTasks } = await import("../src/task-retry.ts");
const { settingsFor } = await import("../src/runtime-policy.ts");
const { TaskViewSchema } = await import("@mackbot/contract");
const Schema = await import("effect/Schema");

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
};

/** One task record: the durable state the harness read back. */
const record = (overrides = {}) => ({
  id: 1,
  conversationId: 7,
  kind: "pi.generation",
  version: 1,
  input: {},
  background: false,
  abortRequested: false,
  state: { status: "running", checkpoint: { phase: "generate" } },
  ...overrides,
});

/** One inspection entry: the record plus the state the scheduler sees. */
const task = (state, overrides = {}) => ({
  record: record(overrides.record),
  state,
});

const inspection = (tasks) => ({ scheduling: "running", tasks, submissions: [] });

/** One task the harness parked after too many restarts. */
const parked = (id, kind = "pi.generation") =>
  task({ kind: "blocked", reason: "restart_limit" }, { record: { id, kind } });

// ---------------------------------------------------------------------------
// Only a parked task is offered to run again.
// ---------------------------------------------------------------------------

{
  const parkedOnly = parkedTasks(inspection([parked(1)]));
  check("a parked task is offered", parkedOnly.length === 1, `${parkedOnly.length}`);
  check("it carries its id", parkedOnly[0].id === "1", parkedOnly[0].id);
  check("it carries its kind", parkedOnly[0].kind === "pi.generation", parkedOnly[0].kind);
  check("it is blocked", parkedOnly[0].status === "blocked", parkedOnly[0].status);
  check(
    "it carries the harness's reason",
    parkedOnly[0].reason === "restart_limit",
    parkedOnly[0].reason,
  );
}

{
  const others = parkedTasks(
    inspection([
      task({ kind: "running" }),
      task({ kind: "ready", migrates: false }),
      task({ kind: "waiting", on: [] }),
      task({ kind: "sleeping", until: 1 }),
      task({ kind: "completing" }),
      task({ kind: "blocked", reason: "missing_task" }),
      task({ kind: "blocked", reason: "task_too_old" }),
      task({ kind: "blocked", reason: "migration_failed" }),
    ]),
  );
  check("no other task is offered", others.length === 0, `${others.length}`);
}

{
  const empty = parkedTasks(inspection([]));
  check("a harness with no live task offers none", empty.length === 0, `${empty.length}`);
}

{
  // A blocked task whose reason is absent is blocked for a reason the harness
  // did not name, which is not the restart limit.
  const unnamed = parkedTasks(inspection([task({ kind: "blocked" })]));
  check("a blocked task with no reason is not parked", unnamed.length === 0, `${unnamed.length}`);
}

// ---------------------------------------------------------------------------
// The order is the numeric id order, so two polls agree.
// ---------------------------------------------------------------------------

{
  const views = parkedTasks(inspection([parked(10), parked(2), parked(7)]));
  check(
    "parked tasks come back in numeric id order",
    views.map((view) => view.id).join(",") === "2,7,10",
    views.map((view) => view.id).join(","),
  );
}

{
  const first = parkedTasks(inspection([parked(10), parked(2)]));
  const second = parkedTasks(inspection([parked(2), parked(10)]));
  check(
    "two polls of the same state project the same order",
    first.map((view) => view.id).join(",") === second.map((view) => view.id).join(","),
    `${first.map((view) => view.id).join(",")} vs ${second.map((view) => view.id).join(",")}`,
  );
}

// ---------------------------------------------------------------------------
// The view is the contract's TaskView, so what the operator receives decodes.
// ---------------------------------------------------------------------------

{
  const views = parkedTasks(inspection([parked(1), parked(2)]));
  let decoded = null;
  try {
    decoded = Schema.decodeUnknownSync(Schema.Array(TaskViewSchema))(views);
  } catch (error) {
    failures.push(`the views do not decode as TaskViews: ${error?.message ?? error}`);
  }
  check("the views decode as the contract's TaskViews", decoded !== null);
}

// ---------------------------------------------------------------------------
// The policy carries the crash-loop guard's limit.
// ---------------------------------------------------------------------------

{
  const bot = (extra) => ({ model: "deepseek-v4-pro", systemPrompt: "x", ...extra });
  check(
    "a bot that declares no limit parks after five restarts",
    settingsFor(bot()).restartLimit === 5,
    `${settingsFor(bot()).restartLimit}`,
  );
  check(
    "a bot with no runtime block parks after five restarts",
    settingsFor(bot({ runtime: {} })).restartLimit === 5,
    `${settingsFor(bot({ runtime: {} })).restartLimit}`,
  );
  check(
    "a declared limit is the one the bot runs under",
    settingsFor(bot({ runtime: { restartLimit: 2 } })).restartLimit === 2,
    `${settingsFor(bot({ runtime: { restartLimit: 2 } })).restartLimit}`,
  );
  check(
    "the rest of the policy is untouched",
    settingsFor(bot({ runtime: { restartLimit: 2 } })).retry.maxRetries === 3,
    `${settingsFor(bot({ runtime: { restartLimit: 2 } })).retry.maxRetries}`,
  );
}

if (failures.length > 0) {
  console.error("task-retry smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("task-retry smoke passed");
process.exit(0);
