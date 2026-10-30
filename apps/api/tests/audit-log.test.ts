import { describe, expect, test } from "vitest";

import * as Schema from "effect/Schema";

import { AUDIT_RETENTION_MS, StoredAuditEventSchema, createAuditLog } from "../src/audit-log.ts";
import type { AuditEvent } from "../src/audit-log.ts";
import { memoryStorage } from "./support/sqlite.ts";

const event = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  timestamp: 1_000,
  botId: "hermes",
  kind: "submission.accepted",
  operationId: "http:one",
  detail: { textLength: 3 },
  ...overrides,
});

const rows = (storage: ReturnType<typeof memoryStorage>) =>
  storage.db
    .prepare("SELECT timestamp, kind, operation_id, detail FROM mackbot_audit ORDER BY rowid")
    .all();

describe("createAuditLog", () => {
  test("stores the detail as JSON", async () => {
    const storage = memoryStorage();
    await createAuditLog(storage).append(event({ detail: { origin: "http", n: [1, 2] } }));
    expect(rows(storage)).toEqual([
      {
        timestamp: 1_000,
        kind: "submission.accepted",
        operation_id: "http:one",
        detail: '{"origin":"http","n":[1,2]}',
      },
    ]);
  });

  test("records one settlement per operation however many observers report it", async () => {
    const storage = memoryStorage();
    const log = createAuditLog(storage);
    await log.append(event({ kind: "settlement.done", timestamp: 1 }));
    await log.append(event({ kind: "settlement.done", timestamp: 2 }));
    await log.append(event({ kind: "submission.replayed", timestamp: 3 }));
    await log.append(event({ kind: "submission.replayed", timestamp: 4 }));
    expect(rows(storage).map((row) => row.kind)).toEqual([
      "settlement.done",
      "submission.replayed",
      "submission.replayed",
    ]);
  });

  test("rejects an event that does not decode, and writes nothing", async () => {
    const storage = memoryStorage();
    const log = createAuditLog(storage);
    const invalid = { ...event(), timestamp: "soon" };
    // SAFETY: the point is an event the type would not allow, as an RPC could send.
    await expect(log.append(invalid as never)).rejects.toBeDefined();
    expect(log.prune(Number.MAX_SAFE_INTEGER)).toBe(0);
  });

  test("prune deletes rows before the cutoff only", async () => {
    const storage = memoryStorage();
    const log = createAuditLog(storage);
    await log.append(event({ timestamp: 10, operationId: "http:old" }));
    await log.append(event({ timestamp: 20, operationId: "http:edge" }));
    await log.append(event({ timestamp: 30, operationId: "http:new" }));

    expect(log.prune(20)).toBe(1);
    expect(rows(storage).map((row) => row.operation_id)).toEqual(["http:edge", "http:new"]);
  });

  test("prune defaults to the retention window", async () => {
    const storage = memoryStorage();
    const log = createAuditLog(storage);
    const now = Date.now();
    await log.append(
      event({ timestamp: now - AUDIT_RETENTION_MS - 60_000, operationId: "http:old" }),
    );
    await log.append(
      event({ timestamp: now - AUDIT_RETENTION_MS + 60_000, operationId: "http:kept" }),
    );

    expect(log.prune()).toBe(1);
    expect(rows(storage).map((row) => row.operation_id)).toEqual(["http:kept"]);
  });

  test("prune works on a fresh table", () => {
    expect(createAuditLog(memoryStorage()).prune()).toBe(0);
  });

  test("records one delegation settlement per operation, however many paths saw it settle", async () => {
    const storage = memoryStorage();
    const log = createAuditLog(storage);
    const settled = { kind: "delegation.settled", operationId: "delegate:hermes:task:4" } as const;
    await log.append(event({ ...settled, timestamp: 1, detail: { via: "call" } }));
    await log.append(event({ ...settled, timestamp: 2, detail: { via: "reporter" } }));
    await log.append(event({ kind: "delegation.reattached", operationId: settled.operationId }));
    await log.append(event({ kind: "delegation.reattached", operationId: settled.operationId }));
    expect(rows(storage).map((row) => row.kind)).toEqual([
      "delegation.settled",
      "delegation.reattached",
      "delegation.reattached",
    ]);
  });

  test("rejects a kind this revision does not write", async () => {
    const log = createAuditLog(memoryStorage());
    // SAFETY: the point is a kind the type would not allow, as a typo would be.
    await expect(log.append(event({ kind: "delegation.requestd" as never }))).rejects.toBeDefined();
  });

  test("a table an earlier revision filled still migrates, prunes, and reads back", async () => {
    const storage = memoryStorage();
    storage.db.exec(
      "CREATE TABLE mackbot_audit (timestamp INTEGER NOT NULL, bot_id TEXT NOT NULL, kind TEXT NOT NULL, operation_id TEXT NOT NULL, detail TEXT)",
    );
    const retired = storage.db.prepare("INSERT INTO mackbot_audit VALUES (?, ?, ?, ?, ?)");
    retired.run(10, "hermes", "tool.call", "executor:x", "{}");
    retired.run(20, "hermes", "settlement", "http:a", '{"status":"done"}');
    const log = createAuditLog(storage);
    await log.append(event({ timestamp: 30, kind: "approval.requested", operationId: "http:b" }));
    expect(log.prune(15)).toBe(1);
    const stored = storage.db
      .prepare(
        "SELECT timestamp, bot_id AS botId, kind, operation_id AS operationId, detail FROM mackbot_audit ORDER BY rowid",
      )
      .all()
      .map((row) => ({ ...row, detail: JSON.parse(String(row.detail)) }));
    expect(Schema.decodeUnknownSync(Schema.Array(StoredAuditEventSchema))(stored)).toEqual([
      {
        timestamp: 20,
        botId: "hermes",
        kind: "settlement",
        operationId: "http:a",
        detail: { status: "done" },
      },
      {
        timestamp: 30,
        botId: "hermes",
        kind: "approval.requested",
        operationId: "http:b",
        detail: { textLength: 3 },
      },
    ]);
  });
});
