import { describe, expect, test } from "vitest";

import { AUDIT_RETENTION_MS, createAuditLog } from "../src/audit-log.ts";
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
});
