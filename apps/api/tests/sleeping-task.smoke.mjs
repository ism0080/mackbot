/**
 * Smoke test for a durable sleep: a task that waits for time, survives a
 * restart, and resumes when its clock reaches the deadline.
 *
 * Run with: bun tests/sleeping-task.smoke.mjs
 *
 * The Pi library can end a task's phase asleep. The task then holds
 * no invocation, its deadline is stored, and a later process picks it up and
 * finishes it. mackbot's approval flow depends on that, so it is proved here
 * against the real storage rather than assumed.
 *
 * The clock is a fake one, so the test does not wait for real time. The
 * storage is a Durable Object's SQLite over bun:sqlite, so the second open is
 * a second process over the same file.
 *
 * The waits are polls, not `waitForIdle`: a sleeping task is live work, so a
 * conversation holding one is never idle and `waitForIdle` would never settle.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTask, Harness } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";

import { durableStorage } from "./support/durable-sqlite.mjs";

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
};

const context = BACKGROUND_CONTEXT;
const directory = mkdtempSync(join(tmpdir(), "mackbot-sleep-"));
const path = join(directory, "session.sqlite");

/** The Harness clock. The test moves it rather than waiting. */
let clock = 1_000_000;
const now = () => clock;

const Sleeper = defineTask({
  name: "example.sleeper",
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: async (task, runtime, taskContext) => {
      // The deadline is stored, not waited on: the phase returns at once.
      await runtime.sleepUntil(now() + 60_000, { phase: "awake" }, taskContext);
    },
    awake: async (task, runtime, taskContext) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: "woke" } }),
        taskContext,
      );
    },
  },
  abort: async (_task, runtime, taskContext) => {
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      taskContext,
    );
  },
});

const registry = createRegistry();
registry.install(defineExtension({ name: "example", tasks: [Sleeper] }));

const open = async () => {
  const database = new Database(path, { create: true });
  const storage = await openDurableObjectSqliteStorage(durableStorage(database), {
    prefix: "pi_",
  });
  const harness = await Harness.open(storage, { models: createModels(), registry, now }, context);
  return { harness, database };
};

const stateOf = async (harness, taskId) => {
  const inspection = await harness.inspect(context);
  return inspection.tasks.find((task) => String(task.record.id) === taskId);
};

/** Poll until the task's state matches, or give up. */
const waitForState = async (harness, taskId, kind) => {
  for (let tries = 0; tries < 200; tries++) {
    const state = await stateOf(harness, taskId);
    if (state?.state.kind === kind) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return await stateOf(harness, taskId);
};

const { harness, database } = await open();
const root = await harness.root(context);

const taskId = await root.commit(
  (tx) => tx.createTask(Sleeper, null, { ownership: { kind: "conversation" } }),
  context,
);
const id = String(taskId);
harness.resume();

const sleeping = await waitForState(harness, id, "sleeping");
check("the task is asleep", sleeping?.state.kind === "sleeping", sleeping?.state.kind);

await harness.close(context);
database.close();

// A second process over the same file finds it still asleep.
const { harness: second, database: secondDatabase } = await open();
const reopened = await stateOf(second, id);
check("the sleep survived the restart", reopened?.state.kind === "sleeping", reopened?.state.kind);

// The deadline is not due yet, so it stays asleep.
second.resume();
await new Promise((resolve) => setTimeout(resolve, 50));
check(
  "it stays asleep before its deadline",
  (await stateOf(second, id))?.state.kind === "sleeping",
  (await stateOf(second, id))?.state.kind,
);

// The clock reaches the deadline: the task wakes and finishes.
clock += 60_001;
second.resume();
await waitForState(second, id, "running");
const record = await second.getTask(taskId, context);
check(
  "it wakes and finishes when the clock reaches the deadline",
  record?.state.status === "terminal" &&
    record.state.outcome.status === "completed" &&
    record.state.outcome.result === "woke",
  JSON.stringify(record?.state),
);

await second.close(context);
secondDatabase.close();
rmSync(directory, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n${failures.length} sleeping task checks failed`);
  process.exit(1);
}
console.log("\nsleeping task smoke passed");
