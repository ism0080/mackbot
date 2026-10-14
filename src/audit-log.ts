/**
 * audit-log — append-only helper over a Durable Object's SQLite storage.
 *
 * Records durable audit events in a *separate* table (`mackbot_audit`) so they
 * never collide with pi-durable's own schema. Appending is idempotent in the
 * sense that every call inserts a new row; callers supply the event identity
 * (timestamp, operationId) they want retained.
 *
 * Public API:
 *
 *   import { createAuditLog } from "./audit-log.ts";
 *   const audit = createAuditLog(storage);
 *   await audit.append({ timestamp: Date.now(), botId, kind, operationId, detail });
 *   const events = await audit.list();
 */

type RawJson = string | number | boolean | null | readonly RawJson[] | RawObject;

interface RawObject {
  readonly [key: string]: RawJson;
}

type RawRow = {
  readonly [key: string]: RawJson;
};

/** One auditable fact. */
export type AuditEvent = {
  readonly timestamp: number;
  readonly botId: string;
  readonly kind: string;
  readonly operationId: string;
  readonly detail: unknown;
};

/** A row cursor as returned by `storage.sql.exec`. */
interface SqlCursor {
  toArray(): readonly RawRow[];
}

/** Either a raw SQLite executor or a Durable Object storage holding one. */
interface SqlExecutor {
  exec(query: string, ...bindings: RawJson[]): SqlCursor | void | Promise<SqlCursor | void>;
}

interface AuditStorage {
  readonly sql?: SqlExecutor;
  exec?(query: string, ...bindings: RawJson[]): SqlCursor | void | Promise<SqlCursor | void>;
}

/** A cursor/executor/promise-aware helper. */
const resolveExecutor = (storage: AuditStorage): SqlExecutor | undefined => {
  const nested = storage.sql;
  if (nested !== undefined && nested !== null && nested.exec instanceof Function) {
    return nested;
  }
  if (storage.exec instanceof Function) {
    // SAFETY: `storage.exec` has the SqlExecutor call signature above.
    return storage as SqlExecutor;
  }
  return undefined;
};

const runSql = async (executor: SqlExecutor, sql: string, ...bindings: RawJson[]): Promise<SqlCursor | void> => {
  const result = executor.exec(sql, ...bindings);
  if (result instanceof Promise) {
    // SAFETY: `executor.exec` resolves to a cursor or void.
    return (await result) as SqlCursor | void;
  }
  return result;
};

const rowsFrom = (raw: SqlCursor | void | readonly RawRow[]): readonly RawRow[] => {
  if (Array.isArray(raw)) {
    // SAFETY: Array.isArray narrowed this runtime value to an array.
    return raw as readonly RawRow[];
  }
  // SAFETY: raw is not an array at this point, so it is only a cursor or void.
  const maybeCursor = raw as SqlCursor;
  if (maybeCursor !== undefined && maybeCursor !== null && maybeCursor.toArray instanceof Function) {
    return maybeCursor.toArray();
  }
  return [];
};

const isStringObject = (value: RawJson | undefined): value is string =>
  Object.prototype.toString.call(value) === "[object String]";

const CREATE_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS mackbot_audit (timestamp INTEGER NOT NULL, bot_id TEXT NOT NULL, kind TEXT NOT NULL, operation_id TEXT NOT NULL, detail TEXT)";

const SELECT_SQL =
  "SELECT timestamp, bot_id, kind, operation_id, detail FROM mackbot_audit ORDER BY timestamp ASC";

const INSERT_SQL =
  "INSERT INTO mackbot_audit (timestamp, bot_id, kind, operation_id, detail) VALUES (?, ?, ?, ?, ?)";

/** Coerce a stored row into an {@link AuditEvent}. */
const rowToEvent = (row: RawRow): AuditEvent => {
  const record = row;
  const timestamp = Number(record.timestamp ?? 0);
  const botId = String(record.bot_id ?? "");
  const kind = String(record.kind ?? "");
  const operationId = String(record.operation_id ?? "");
  let detail: unknown = record.detail ?? null;
  // SAFETY: detail originates from a parsed storage row.
  const detailCandidate = detail as RawJson | undefined;
  if (isStringObject(detailCandidate)) {
    // SAFETY: isStringObject returned true, so detail is a string here.
    const detailText = detail as string;
    try {
      detail = JSON.parse(detailText);
    } catch {
      /* keep the raw string when it is not JSON */
    }
  }
  return { timestamp, botId, kind, operationId, detail };
};

/** The handle returned by {@link createAuditLog}. */
export type AuditLog = {
  readonly append: (event: AuditEvent) => Promise<void>;
  readonly list: (limit?: number) => Promise<readonly AuditEvent[]>;
  readonly migrate: () => void | Promise<void>;
};

/**
 * Build an append-only audit log backed by the given Durable Object SQLite
 * storage. The `mackbot_audit` table is created on demand (idempotent).
 */
export function createAuditLog(storage: AuditStorage): AuditLog {
  const executor = resolveExecutor(storage);
  if (executor === undefined) {
    throw new Error("createAuditLog requires Durable Object SQLite storage");
  }

  const migrate = async (): Promise<void> => {
    await runSql(executor, CREATE_TABLE_SQL);
  };

  const append = async (event: AuditEvent): Promise<void> => {
    await migrate();
    await runSql(
      executor,
      INSERT_SQL,
      event.timestamp,
      event.botId,
      event.kind,
      event.operationId,
      JSON.stringify(event.detail === undefined ? null : event.detail),
    );
  };

  const list = async (limit?: number): Promise<readonly AuditEvent[]> => {
    await migrate();
    const raw = await runSql(executor, SELECT_SQL);
    const rows = rowsFrom(raw);
    const events = rows.map(rowToEvent);
    return limit === undefined ? events : events.slice(0, limit);
  };

  // Best-effort table creation up front; harmless if the storage is lazy.
  void migrate();

  return { append, list, migrate };
}