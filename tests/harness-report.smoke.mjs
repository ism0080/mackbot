/**
 * Smoke test for the failure report, end to end: the harness reports it, and
 * mackbot's store keeps it.
 *
 * Run with: bun tests/harness-report.smoke.mjs
 *
 * A task phase that throws faults. The harness reports that through
 * `onReport`, with its own word for what happened and the task it is about.
 * mackbot's store is what turns that into what `/status` shows, so this drives
 * the real chain rather than a hand-made report.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTask, Harness } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";

import { createFailureStore } from "../src/failures.ts";
import { durableStorage } from "./support/durable-sqlite.mjs";
import { sqliteStorage } from "./support/sqlite.mjs";

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
};

const context = BACKGROUND_CONTEXT;
const directory = mkdtempSync(join(tmpdir(), "mackbot-report-"));

// A task whose phase throws: the harness faults it and reports it.
const Faulty = defineTask({
  name: "example.faulty",
  version: 1,
  initial: () => ({ phase: "boom" }),
  phases: {
    boom: async () => {
      throw new Error("the phase exploded");
    },
  },
  abort: async (_task, runtime, taskContext) => {
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      taskContext,
    );
  },
});

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage("Nothing to do.")]);

const registry = createRegistry();
registry.install(defineExtension({ name: "example", tasks: [Faulty] }));

const database = new Database(join(directory, "session.sqlite"), { create: true });
const storage = await openDurableObjectSqliteStorage(durableStorage(database), { prefix: "pi_" });
// mackbot's own tables live in the Durable Object's SQLite, beside pi's.
const store = createFailureStore(sqliteStorage(database));

const reports = [];
const harness = await Harness.open(
  storage,
  {
    models,
    registry,
    onReport: (cause, info) => {
      reports.push(info.type);
      store.record(cause, info);
    },
  },
  context,
);
const root = await harness.root(context);

const taskId = await root.commit(
  (tx) => tx.createTask(Faulty, null, { ownership: { kind: "conversation" } }),
  context,
);
harness.resume();

// The faulted task settles as failed; the report is what mackbot keeps.
for (let tries = 0; tries < 200; tries++) {
  const record = await harness.getTask(taskId, context);
  if (record?.state.status === "terminal") break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const record = await harness.getTask(taskId, context);
check("the faulted task settled", record?.state.status === "terminal", record?.state.status);
// pi distinguishes a task whose code threw ("faulted") from one that decided
// it failed ("failed").
check("it settled as faulted", record?.state.outcome.status === "faulted", record?.state.outcome?.status);

check("the harness reported it", reports.length > 0, JSON.stringify(reports));
check(
  "it reported a faulted task",
  reports.includes("task_faulted"),
  JSON.stringify(reports),
);

const kept = store.recent();
check("the store kept the report", kept.length === 1, `${kept.length}`);
check("it kept pi's word for it", kept[0]?.kind === "task_faulted", kept[0]?.kind);
check("it kept the task's id", kept[0]?.taskId === String(taskId), kept[0]?.taskId);
check("it kept the task's kind", kept[0]?.taskKind === "example.faulty", kept[0]?.taskKind);
check("it kept the extension that installed it", kept[0]?.extension === "example", kept[0]?.extension);
check("it kept the error's name", kept[0]?.name === "Error", kept[0]?.name);
check(
  "it kept the error's message",
  kept[0]?.detail.includes("the phase exploded") === true,
  kept[0]?.detail,
);

await harness.close(context);
database.close();
rmSync(directory, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n${failures.length} harness report checks failed`);
  process.exit(1);
}
console.log("\nharness report smoke passed");
