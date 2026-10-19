/**
 * Smoke test for the liveness projection (src/liveness.ts).
 *
 * Run with: bun tests/liveness.smoke.mjs
 *
 * The claims this file has to break if they stop holding:
 *   1. The harness's own word for a task's state reaches the operator:
 *      running, ready (which the view calls pending), waiting, completing and
 *      blocked each project to their own status.
 *   2. A blocked task carries the reason the harness gave, and no other task
 *      claims one.
 *   3. A task's phase is the step its checkpoint names, and a checkpoint that
 *      does not carry a string phase contributes none.
 *   4. A child task names the task that owns it; a conversation-owned task
 *      names none.
 *   5. Two tasks come back in numeric id order, so two polls of the same
 *      state produce the same list.
 *
 * The inspections are plain objects: this file proves the projection, not the
 * harness.
 */

const { projectTasks } = await import("../src/liveness.ts");

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

// ---------------------------------------------------------------------------
// The harness's word for a task's state is the status the view reports.
// ---------------------------------------------------------------------------

{
  const [running] = projectTasks(inspection([task({ kind: "running" })]));
  check("a running task is running", running.status === "running", running.status);
  check("a running task carries its phase", running.phase === "generate", running.phase);
}

{
  const [ready] = projectTasks(inspection([task({ kind: "ready", migrates: false })]));
  check("a ready task is pending", ready.status === "pending", ready.status);
}

{
  const [waiting] = projectTasks(inspection([task({ kind: "waiting", on: [] })]));
  check("a waiting task is waiting", waiting.status === "waiting", waiting.status);
}

{
  const [completing] = projectTasks(
    inspection([
      task(
        { kind: "completing" },
        { record: { state: { status: "completing", outcome: { status: "completed" } } } },
      ),
    ]),
  );
  check("a completing task is completing", completing.status === "completing", completing.status);
  check("a completing task has no phase", completing.phase === undefined, `${completing.phase}`);
}

{
  const [blocked] = projectTasks(
    inspection([task({ kind: "blocked", reason: "missing_task" })]),
  );
  check("a blocked task is blocked", blocked.status === "blocked", blocked.status);
  check("a blocked task carries the harness's reason", blocked.reason === "missing_task", blocked.reason);
}

{
  const [running] = projectTasks(inspection([task({ kind: "running" })]));
  check("a task that is not blocked has no reason", running.reason === undefined, `${running.reason}`);
}

// ---------------------------------------------------------------------------
// The phase is the checkpoint's own step, read defensively.
// ---------------------------------------------------------------------------

{
  const [phaseless] = projectTasks(
    inspection([
      task(
        { kind: "running" },
        { record: { state: { status: "running", checkpoint: { step: 2 } } } },
      ),
    ]),
  );
  check("a checkpoint without a phase has none", phaseless.phase === undefined, `${phaseless.phase}`);
}

{
  const [numbered] = projectTasks(
    inspection([
      task(
        { kind: "running" },
        { record: { state: { status: "running", checkpoint: { phase: 3 } } } },
      ),
    ]),
  );
  check("a phase that is not a string has none", numbered.phase === undefined, `${numbered.phase}`);
}

// ---------------------------------------------------------------------------
// Ownership: a child task names its owner, a conversation-owned task names none.
// ---------------------------------------------------------------------------

{
  const [owned, orphan] = projectTasks(
    inspection([
      task({ kind: "running" }, { record: { id: 1, owner: 42 } }),
      task({ kind: "running" }, { record: { id: 2 } }),
    ]),
  );
  check("a child task names its owner", owned.owner === "42", `${owned.owner}`);
  check("a conversation-owned task names no owner", orphan.owner === undefined, `${orphan.owner}`);
}

// ---------------------------------------------------------------------------
// The order is the numeric id order, so two polls agree.
// ---------------------------------------------------------------------------

{
  const views = projectTasks(
    inspection([
      task({ kind: "running" }, { record: { id: 10 } }),
      task({ kind: "ready", migrates: false }, { record: { id: 2 } }),
      task({ kind: "waiting", on: [] }, { record: { id: 7 } }),
    ]),
  );
  check(
    "tasks come back in numeric id order",
    views.map((view) => view.id).join(",") === "2,7,10",
    views.map((view) => view.id).join(","),
  );
}

// ---------------------------------------------------------------------------
// The rest of the record reaches the view.
// ---------------------------------------------------------------------------

{
  const [view] = projectTasks(
    inspection([
      task(
        { kind: "running" },
        {
          record: {
            id: 5,
            conversationId: 3,
            kind: "pi.compaction",
            background: true,
          },
        },
      ),
    ]),
  );
  check("the task id is the record's", view.id === "5", view.id);
  check("the kind is the record's", view.kind === "pi.compaction", view.kind);
  check("the session is the conversation's", view.session === "3", view.session);
  check("a background task says so", view.background === true, `${view.background}`);
}

{
  const views = projectTasks(inspection([]));
  check("a harness with no live task reports none", views.length === 0, `${views.length}`);
}

if (failures.length > 0) {
  console.error("liveness smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("liveness smoke passed");
process.exit(0);
