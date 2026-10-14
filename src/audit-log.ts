/**
 * audit-log — append-only helper ...
 */

import { Effect, Schema } from "effect";

type RawJson = string | number | boolean | null | readonly RawJson[] | RawObject;

interface RawObject {
  readonly [key: string]: RawJson;
}

type RawRow = {
  readonly [key: string]: RawJson;
};

export const AuditEventSchema = Schema.Struct({
  timestamp: Schema.Number,
  botId: Schema.String,
  kind: Schema.String,
  operationId: Schema.String,
  detail: Schema.Unknown,
});

export type AuditEvent = Schema.Schema.Type<typeof AuditEventSchema>;

interface SqlCursor {
  toArray(): readonly RawRow[];
}

interface SqlExecutor {
  exec(query: string, ...bindings: RawJson[]): SqlCursor | void | Promise<SqlCursor | void>;
}

interface AuditStorage {
  readonly sql?: SqlExecutor;
  exec?(query: string, ...bindings: RawJson[]): SqlCursor | void | Promise<SqlCursor | void>;
}

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

export type AuditLog = {
  readonly append: (event: AuditEvent) => Promise<void>;
  readonly list: (limit?: number) => Promise<readonly AuditEvent[]>;
  readonly migrate: () => void | Promise<void>;
};

export function createAuditLog(storage: AuditStorage): AuditLog {
  const executor = resolveExecutor(storage);
  if (executor === undefined) {
    throw new Error("createAuditLog requires Durable Object SQLite storage");
  }

  // Lift the storage migration into Effect so the boundary stays idiomatic.
  const migrateEffect = (sql: string) =>
    Effect.tryPromise({ try: async () => runSql(executor, sql), catch: (cause) => cause });

  const migrate = async (): Promise<void> => {
    await Effect.runPromise(migrateEffect(CREATE_TABLE_SQL));
  };

  const append = async (event: AuditEvent): Promise<void> => {
    const validated = Schema.decodeUnknownSync(AuditEventSchema)(event);
    await migrate();
    await Effect.runPromise(
      Effect.tryPromise({
        try: async () =>
          runSql(
            executor,
            INSERT_SQL,
            validated.timestamp,
            validated.botId,
            validated.kind,
            validated.operationId,
            JSON.stringify(validated.detail === undefined ? null : validated.detail),
          ),
        catch: (cause) => cause,
      }),
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