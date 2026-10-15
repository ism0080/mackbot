/**
 * Smoke test for the audit-log helper (src/audit-log.ts).
 *
 * Run with: bun tests/audit-log.smoke.mjs
 *
 * Exercises table creation, append, and list against an in-memory storage mock.
 */
const { createAuditLog } = await import("../src/audit-log.ts");

const rows = [];
const storage = {
  sql: {
    exec: (sql, ...bindings) => {
      if (/CREATE TABLE/i.test(sql)) return { toArray: () => [] };
      if (/INSERT/i.test(sql)) {
        rows.push([...bindings]);
        return { toArray: () => [] };
      }
      if (/SELECT/i.test(sql)) {
        const selected = /LIMIT/i.test(sql) ? rows.slice(-Number(bindings[0])) : rows;
        return {
          toArray: () =>
            selected.map(([timestamp, botId, kind, operationId, detail]) => ({
              timestamp,
              bot_id: botId,
              kind,
              operation_id: operationId,
              detail,
            })),
        };
      }
      return { toArray: () => [] };
    },
  },
};

const audit = createAuditLog(storage);
const failures = [];

const createCalls = [];
const wrapped = {
  sql: {
    exec: (sql, ...bindings) => {
      createCalls.push(sql);
      return storage.sql.exec(sql, ...bindings);
    },
  },
};
const _audit2 = createAuditLog(wrapped);

await new Promise((r) => setTimeout(r, 10));

if (!createCalls.some((s) => /CREATE TABLE IF NOT EXISTS mackbot_audit/i.test(s))) {
  failures.push("CREATE TABLE not issued");
}

await audit.append({
  timestamp: 123,
  botId: "hermes",
  kind: "tool.call",
  operationId: "op-1",
  detail: { tool: "delegate_to_bot" },
});
const events = await audit.list();
if (events.length !== 1) failures.push(`expected 1 event, got ${events.length}`);
if (events[0]?.botId !== "hermes") failures.push("botId mismatch");
if (events[0]?.detail?.tool !== "delegate_to_bot") failures.push("detail mismatch");

await audit.append({
  timestamp: 124,
  botId: "hermes",
  kind: "tool.call",
  operationId: "op-2",
  detail: { tool: "executor_search" },
});
const recent = await audit.list(1);
if (recent.length !== 1) failures.push(`list(1) expected 1 event, got ${recent.length}`);
if (recent[0]?.operationId !== "op-2") failures.push(`list(1) returned ${recent[0]?.operationId}`);

const directRows = [];
const direct = createAuditLog({
  exec: (sql, ...bindings) => {
    if (/CREATE TABLE/i.test(sql)) return [];
    if (/INSERT/i.test(sql)) {
      directRows.push([...bindings]);
      return [];
    }
    if (/SELECT/i.test(sql)) {
      return directRows.map(([timestamp, botId, kind, operationId, detail]) => ({
        timestamp,
        bot_id: botId,
        kind,
        operation_id: operationId,
        detail,
      }));
    }
    return [];
  },
});
await direct.append({ timestamp: 1, botId: "x", kind: "k", operationId: "o", detail: "d" });
const directEvents = await direct.list();
if (directEvents.length !== 1) failures.push(`direct: expected 1, got ${directEvents.length}`);
if (directEvents[0]?.detail !== "d")
  failures.push(`direct: detail mismatch ${directEvents[0]?.detail}`);

if (failures.length > 0) {
  console.error("audit-log smoke FAILED:");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}
console.log("audit-log smoke passed");
process.exit(0);
