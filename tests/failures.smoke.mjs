/**
 * Smoke test for the failure store (src/failures.ts).
 *
 * Run with: bun tests/failures.smoke.mjs
 *
 * The claims this file has to break if they stop holding:
 *   1. A failure keeps the harness's own word for it: pi's `ReportInfo.type`.
 *   2. A report about a task carries that task's id and kind, and the
 *      extension that installed it.
 *   3. A `host_error` names the callback that failed, and an `extension_error`
 *      names the extension.
 *   4. A long detail is capped at 500 characters, marker included.
 *   5. A recorded failure comes back from `recent`, newest first.
 *   6. A row the contract cannot decode is skipped, not thrown.
 *   7. `clear` forgets every recorded failure.
 */
import { Database } from "bun:sqlite";
import { sqliteStorage } from "./support/sqlite.mjs";

const { createFailureStore, classifyFailure } = await import("../src/failures.ts");
const { SessionFailed } = await import("@earendil-works/pi-durable");

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
};

const fresh = () => {
  const database = new Database(":memory:");
  return { database, store: createFailureStore(sqliteStorage(database)) };
};

/** The task a report is about, as pi hands it over. */
const task = (id, kind) => ({ id, kind, conversationId: 1 });

// ---------------------------------------------------------------------------
// The harness names the failure; the store keeps that name.
// ---------------------------------------------------------------------------

{
  const failure = classifyFailure(new SessionFailed(new Error("storage gone")), {
    type: "session_failed",
  });
  check(
    "a session failure keeps the harness's word",
    failure.kind === "session_failed",
    failure.kind,
  );
  check("a SessionFailed keeps its own name", failure.name === "SessionFailed", failure.name);
  check(
    "a SessionFailed keeps its message",
    failure.detail === "Session failed after a storage error; close and reopen it",
    failure.detail,
  );
}

{
  const failure = classifyFailure(new TypeError("bad thing"), {
    type: "task_parked",
    task: task(42, "summary"),
  });
  check(
    "the harness's word wins over the error's class",
    failure.kind === "task_parked",
    failure.kind,
  );
  check("the error still names itself", failure.name === "TypeError", failure.name);
}

// ---------------------------------------------------------------------------
// A report about a task carries that task, and the extension behind it.
// ---------------------------------------------------------------------------

{
  const failure = classifyFailure(new Error("parked"), {
    type: "task_parked",
    task: task(42, "summary"),
    extension: "memory",
  });
  check("a parked task keeps its own kind", failure.kind === "task_parked", failure.kind);
  check("a parked task names its id", failure.taskId === "42", failure.taskId);
  check("a parked task names its kind", failure.taskKind === "summary", failure.taskKind);
  check(
    "a parked task names the extension that installed it",
    failure.extension === "memory",
    failure.extension,
  );
}

{
  const failure = classifyFailure(new Error("broke"), {
    type: "host_error",
    callback: "now",
  });
  check("a host error keeps its own kind", failure.kind === "host_error", failure.kind);
  check(
    "a host error names the callback that failed",
    failure.callback === "now",
    failure.callback,
  );
  check("a host error has no task", failure.taskId === undefined, failure.taskId);
}

{
  const failure = classifyFailure(new Error("broke"), {
    type: "extension_error",
    extension: "memory",
  });
  check("an extension error keeps its own kind", failure.kind === "extension_error", failure.kind);
  check(
    "an extension error names the extension",
    failure.extension === "memory",
    failure.extension,
  );
  check("an extension error has no task", failure.taskId === undefined, failure.taskId);
}

{
  const failure = classifyFailure(new Error("broke"), { type: "listener_error" });
  check("a listener error keeps its own kind", failure.kind === "listener_error", failure.kind);
  check("a listener error has no task", failure.taskId === undefined, failure.taskId);
  check("a listener error has no task kind", failure.taskKind === undefined, failure.taskKind);
}

// ---------------------------------------------------------------------------
// A long detail is capped, marker included.
// ---------------------------------------------------------------------------

{
  const long = "x".repeat(600);
  const failure = classifyFailure(new Error(long), {
    type: "task_error",
    task: task(3, "summary"),
  });
  check(
    "a long detail is 500 characters",
    failure.detail.length === 500,
    `${failure.detail.length}`,
  );
  check(
    "a long detail ends with the marker",
    failure.detail.endsWith("..."),
    failure.detail.slice(-6),
  );
  check(
    "a long detail keeps the first 497 characters",
    failure.detail.slice(0, 497) === long.slice(0, 497),
  );
}

{
  const exact = "y".repeat(500);
  const failure = classifyFailure(new Error(exact), { type: "session_failed" });
  check("a detail of exactly 500 characters is kept whole", failure.detail === exact);
}

// ---------------------------------------------------------------------------
// A recorded failure comes back newest first.
// ---------------------------------------------------------------------------

{
  const { store } = fresh();
  const before = Date.now();
  store.record(new TypeError("first"), { type: "session_failed" });
  store.record(new RangeError("second"), {
    type: "task_parked",
    task: task(7, "summary"),
  });
  const recent = store.recent();
  check("recent holds both failures", recent.length === 2, `${recent.length}`);
  check("recent is newest first", recent[0]?.detail === "second", recent[0]?.detail);
  check("recent keeps the newest name", recent[0]?.name === "RangeError", recent[0]?.name);
  check("recent keeps the newest kind", recent[0]?.kind === "task_parked", recent[0]?.kind);
  check("recent keeps the oldest too", recent[1]?.detail === "first", recent[1]?.detail);
  check("recent stamps the time", recent[0]?.at !== undefined && recent[0].at >= before);
  check("recent caps the list", store.recent(1).length === 1, `${store.recent(1).length}`);
}

{
  const { store } = fresh();
  store.record(new Error("parked"), {
    type: "task_parked",
    task: task(42, "summary"),
    extension: "memory",
  });
  const [failure] = store.recent();
  check("the recorded failure keeps its kind", failure?.kind === "task_parked", failure?.kind);
  check("the recorded failure keeps the task id", failure?.taskId === "42", failure?.taskId);
  check(
    "the recorded failure keeps the task kind",
    failure?.taskKind === "summary",
    failure?.taskKind,
  );
  check(
    "the recorded failure keeps the extension",
    failure?.extension === "memory",
    failure?.extension,
  );
}

{
  const { store } = fresh();
  store.record(new Error("broke"), { type: "host_error", callback: "registry" });
  const [failure] = store.recent();
  check(
    "the recorded host error keeps the callback",
    failure?.callback === "registry",
    failure?.callback,
  );
  check("the recorded host error has no task", failure?.taskId === undefined, failure?.taskId);
}

// ---------------------------------------------------------------------------
// A row the contract cannot decode is skipped, not thrown.
// ---------------------------------------------------------------------------

{
  const { database, store } = fresh();
  store.record(new TypeError("good"), { type: "session_failed" });
  database
    .query("INSERT INTO mackbot_failures (at, kind, name, detail) VALUES (?, ?, ?, ?)")
    .run(1, "not_a_kind", "Broken", "detail");
  database
    .query("INSERT INTO mackbot_failures (at, kind, name, detail) VALUES (?, ?, ?, ?)")
    .run("not-a-number", "session_failed", "Broken", "detail");
  const recent = store.recent();
  check("an undecodable row is skipped", recent.length === 1, `${recent.length}`);
  check("the decodable row survives", recent[0]?.detail === "good", recent[0]?.detail);
}

// ---------------------------------------------------------------------------
// A failing write never takes down the caller that reported the failure.
// ---------------------------------------------------------------------------

{
  const { database, store } = fresh();
  store.record(new TypeError("one"), { type: "session_failed" });
  database.query("DROP TABLE mackbot_failures").run();
  let threw = false;
  try {
    store.record(new TypeError("two"), { type: "session_failed" });
  } catch {
    threw = true;
  }
  check("a failing write does not throw", !threw);
}

// ---------------------------------------------------------------------------
// `clear` forgets every recorded failure.
// ---------------------------------------------------------------------------

{
  const { store } = fresh();
  store.record(new TypeError("one"), { type: "session_failed" });
  store.record(new RangeError("two"), {
    type: "task_faulted",
    task: task(9, "summary"),
    reason: "threw",
  });
  check("the store holds the failures", store.recent().length === 2, `${store.recent().length}`);
  store.clear();
  check("clear empties the store", store.recent().length === 0, `${store.recent().length}`);
}

if (failures.length > 0) {
  console.error("failures smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("failures smoke passed");
process.exit(0);
