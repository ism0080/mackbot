/**
 * Smoke test for the audit-log seam (src/audit-log.ts).
 *
 * Run with: bun tests/audit-log.smoke.mjs
 *
 * Runs against real SQLite through bun:sqlite, so the table and the unique index
 * this module creates are the ones actually exercised. A mock that pattern-matches
 * SQL cannot show whether a constraint holds, which is the whole point of the
 * settlement index.
 */
import { Database } from "bun:sqlite";

const { createAuditLog } = await import("../src/audit-log.ts");

const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}: ${detail}`);
};

/** The shape src/audit-log.ts expects of a Durable Object's SQLite storage. */
const storageOf = (database) => ({
  sql: {
    exec: (sql, ...bindings) => {
      const statement = database.query(sql);
      if (/^\s*(?:SELECT|PRAGMA)/iu.test(sql)) {
        return { toArray: () => statement.all(...bindings) };
      }
      statement.run(...bindings);
      return { toArray: () => [] };
    },
  },
});

const fresh = () => {
  const database = new Database(":memory:");
  return { database, audit: createAuditLog(storageOf(database)) };
};

const event = (overrides) => ({
  timestamp: 1,
  botId: "hermes",
  kind: "settlement.done",
  operationId: "http:one",
  detail: { session: "1" },
  ...overrides,
});

// The migration has to leave both the table and the unique index behind, since
// the index is what makes a repeat settlement collapse.
{
  const { database, audit } = fresh();
  await audit.migrate();
  const names = (type) =>
    database
      .query("SELECT name FROM sqlite_master WHERE type = ?")
      .all(type)
      .map((row) => row.name);
  check("migration", names("table").includes("mackbot_audit"), "table missing");
  check("migration", names("index").includes("mackbot_audit_settlement"), "index missing");
}

// A record survives the round trip, including a structured detail.
{
  const { audit } = fresh();
  await audit.append(event({ timestamp: 123, detail: { tool: "executor_search" } }));
  const events = await audit.list();
  check("round trip", events.length === 1, `got ${events.length}`);
  check("round trip", events[0].timestamp === 123, "timestamp");
  check("round trip", events[0].botId === "hermes", "botId");
  check("round trip", events[0].kind === "settlement.done", "kind");
  check("round trip", events[0].operationId === "http:one", "operationId");
  check("round trip", events[0].detail.tool === "executor_search", "detail");
}

// A detail that is not JSON keeps its text rather than throwing.
{
  const { audit } = fresh();
  await audit.append(event({ detail: "plain text" }));
  check("non-JSON detail", (await audit.list())[0].detail === "plain text", "detail changed");
}

// The settlement index: two observers of one settled operation record one row.
{
  const { audit } = fresh();
  await audit.append(event({ timestamp: 1, operationId: "http:a" }));
  await audit.append(event({ timestamp: 2, operationId: "http:a" }));
  const events = await audit.list();
  check("repeat settlement", events.length === 1, `got ${events.length}`);
  check("repeat settlement", events[0].timestamp === 1, "kept the later observation");
}

// Two settled statuses for one operation are different facts and both stand.
{
  const { audit } = fresh();
  await audit.append(event({ kind: "settlement.done", operationId: "http:a" }));
  await audit.append(event({ kind: "settlement.unanswered", operationId: "http:a" }));
  check("both statuses", (await audit.list()).length === 2, "collapsed the two statuses");
}

// Two different operations settle independently.
{
  const { audit } = fresh();
  await audit.append(event({ operationId: "http:a" }));
  await audit.append(event({ operationId: "http:b" }));
  check("distinct operations", (await audit.list()).length === 2, "collapsed two operations");
}

// Retries are events, not facts, so each one is recorded.
{
  const { audit } = fresh();
  await audit.append(event({ kind: "submission.replayed", timestamp: 1 }));
  await audit.append(event({ kind: "submission.replayed", timestamp: 2 }));
  await audit.append(event({ kind: "submission.accepted", timestamp: 3 }));
  check("replays are events", (await audit.list()).length === 3, "a replay was dropped");
}

// `list(limit)` takes the newest rows and returns them oldest first.
{
  const { audit } = fresh();
  for (const [index, id] of ["a", "b", "c"].entries()) {
    await audit.append(
      event({ kind: "submission.accepted", operationId: `http:${id}`, timestamp: index + 1 }),
    );
  }
  const recent = await audit.list(2);
  check("recent limit", recent.length === 2, `got ${recent.length}`);
  check(
    "recent limit",
    recent.map((entry) => entry.operationId).join(",") === "http:b,http:c",
    `got ${recent.map((entry) => entry.operationId).join(",")}`,
  );
}

// An empty log is an empty list, not an error.
{
  const { audit } = fresh();
  check("empty log", (await audit.list()).length === 0, "not empty");
}

// A storage that exposes `exec` at the top level is the other shape the seam
// accepts, so it gets the same round trip.
{
  const database = new Database(":memory:");
  const audit = createAuditLog(storageOf(database).sql);
  await audit.append(event({ detail: { via: "top level" } }));
  const events = await audit.list();
  check("top-level exec", events.length === 1, `got ${events.length}`);
  check("top-level exec", events[0].detail.via === "top level", "did not read back");
}

// A storage with no SQL at all is refused rather than silently dropping writes.
{
  let message = "";
  try {
    createAuditLog({});
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check("storage without sql", message.includes("requires"), `message: ${JSON.stringify(message)}`);
}

if (failures.length > 0) {
  console.error("audit-log smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("audit-log smoke passed");
process.exit(0);
