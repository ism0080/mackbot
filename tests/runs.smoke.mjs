/**
 * Smoke test for the run table and the entry join (src/runs.ts).
 *
 * Run with: bun tests/runs.smoke.mjs
 *
 * The claims this file has to break if they stop holding:
 *   1. An entry inside a run's window gets that run's `at` and `origin`; an
 *      entry outside every window gets neither.
 *   2. The next run's admission closes the previous window just before it, so
 *      the windows partition the ids instead of overlapping.
 *   3. A replayed submission is one window, not two.
 */
import { Database } from "bun:sqlite";
import { sqliteStorage } from "./support/sqlite.mjs";

const { createRunStore, runForEntry, streamIdFor } = await import("../src/runs.ts");
const { highestEntryId, transcriptPage } = await import("../src/transcript.ts");

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
};

const fresh = () => {
  const database = new Database(":memory:");
  return { database, runs: createRunStore(sqliteStorage(database)) };
};

const entry = (id, text) => ({
  id,
  conversationId: 7,
  kind: "pi.user",
  model: [{ role: "user", content: text, timestamp: 1 }],
});

const stream = { stream: "feed:1:1", generation: 1, cursor: 0, state: "streaming" };

// ---------------------------------------------------------------------------
// Opening a run allocates an ordinal, names the stream, and records the mark.
// ---------------------------------------------------------------------------

{
  const { runs } = fresh();
  runs.open({
    sessionId: "1",
    operationId: "http:a",
    inputs: ["do the thing"],
    startedAt: 1_000,
    startEntry: 5,
  });
  const [row] = runs.list();
  check("open records one run", runs.list().length === 1);
  check("open allocates the first ordinal", row.ordinal === 1, `${row.ordinal}`);
  check("open names the stream by session and ordinal", row.streamId === streamIdFor("1", 1), row.streamId);
  check("open keeps the inputs", JSON.stringify(row.inputs) === '["do the thing"]');
  check("open starts running", row.status === "running");
  check("open records the entry mark", row.startEntry === 5, `${row.startEntry}`);
}

// ---------------------------------------------------------------------------
// The join: inside a window the entry is dated and attributed; outside it is not.
// ---------------------------------------------------------------------------

{
  const { runs } = fresh();
  runs.open({
    sessionId: "1",
    operationId: "cron:hermes:1",
    inputs: [],
    startedAt: 1_000,
    startEntry: 5,
  });
  runs.settle({ sessionId: "1", operationId: "cron:hermes:1", endEntry: 7, settledAt: 2_000 });
  const rows = runs.list();

  const inside = runForEntry(6, rows);
  const before = runForEntry(4, rows);
  const after = runForEntry(8, rows);
  check("an entry inside the window finds the run", inside?.ordinal === 1);
  check("an entry before the window finds nothing", before === undefined);
  check("an entry after the window finds nothing", after === undefined);

  const page = transcriptPage(
    "1",
    [entry(4, "earlier"), entry(6, "during"), entry(8, "later")],
    rows,
    { limit: 200 },
    stream,
  );
  check("the inside entry is dated", page.entries[1]?.at === 1_000, `${page.entries[1]?.at}`);
  check("the inside entry carries the origin", page.entries[1]?.origin === "cron", page.entries[1]?.origin);
  check("the earlier entry is undated", page.entries[0]?.at === undefined);
  check("the later entry is undated", page.entries[2]?.at === undefined);
}

// ---------------------------------------------------------------------------
// Admission of the next run closes the previous window just before it.
// ---------------------------------------------------------------------------

{
  const { runs } = fresh();
  runs.open({ sessionId: "1", operationId: "http:a", inputs: ["a"], startedAt: 1_000, startEntry: 5 });
  runs.open({ sessionId: "1", operationId: "http:b", inputs: ["b"], startedAt: 3_000, startEntry: 9 });
  const rows = runs.list();
  const first = rows.find((row) => row.ordinal === 1);
  const second = rows.find((row) => row.ordinal === 2);
  check("the next admission closes the previous window", first?.endEntry === 8, `${first?.endEntry}`);
  check("the closed window is completed", first?.status === "completed");
  check("the closed window is stamped with the next admission", first?.settledAt === 3_000, `${first?.settledAt}`);
  check("the new window is open", second?.endEntry === undefined);

  check("an id in the first window is the first run", runForEntry(7, rows)?.ordinal === 1);
  check("an id at the boundary is the second run", runForEntry(9, rows)?.ordinal === 2);
}

// ---------------------------------------------------------------------------
// Settlement stamps the exact end; a replay adds no second window.
// ---------------------------------------------------------------------------

{
  const { runs } = fresh();
  const run = { sessionId: "1", operationId: "http:a", inputs: ["a"], startedAt: 1_000, startEntry: 5 };
  runs.open(run);
  runs.open(run);
  check("a replayed submission is one window", runs.list().length === 1, `${runs.list().length}`);

  runs.settle({ sessionId: "1", operationId: "http:a", endEntry: 6, settledAt: 2_000 });
  runs.settle({ sessionId: "1", operationId: "http:a", endEntry: 99, settledAt: 9_999 });
  const [row] = runs.list();
  check("settle stamps the end", row.endEntry === 6, `${row.endEntry}`);
  check("settle stamps the time", row.settledAt === 2_000, `${row.settledAt}`);
  check("settle is idempotent", row.status === "completed");
}

// ---------------------------------------------------------------------------
// Ordinals are per session: two threads interleaving do not share one counter.
// ---------------------------------------------------------------------------

{
  const { runs } = fresh();
  runs.open({ sessionId: "1", operationId: "http:a", inputs: [], startedAt: 1, startEntry: 1 });
  runs.open({ sessionId: "2", operationId: "http:b", inputs: [], startedAt: 2, startEntry: 1 });
  const ordinals = runs.list().map((row) => `${row.sessionId}:${row.ordinal}`).join(",");
  check("ordinals count per session", ordinals === "1:1,2:1", ordinals);
}

check("the high-water mark is the newest id", highestEntryId([entry(3, "a"), entry(9, "b"), entry(5, "c")]) === 9);

if (failures.length > 0) {
  console.error("runs smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("runs smoke passed");
process.exit(0);
