/**
 * audit-log — append-only helper ...
 */

import { Effect, Predicate, Schema } from "effect";

type SqlBinding = string | number | boolean | null;

type SqlRow = {
  readonly [key: string]: SqlBinding;
};

export const AuditEventSchema = Schema.Struct({
  timestamp: Schema.Number,
  botId: Schema.String,
  kind: Schema.String,
  operationId: Schema.String,
  detail: Schema.Json,
});

export type AuditEvent = Schema.Schema.Type<typeof AuditEventSchema>;

interface SqlCursor {
  toArray(): readonly SqlRow[];
}

interface SqlExecutor {
  exec(query: string, ...bindings: SqlBinding[]): SqlCursor | void | Promise<SqlCursor | void>;
}

interface AuditStorage {
  readonly sql?: SqlExecutor;
  exec?(query: string, ...bindings: SqlBinding[]): SqlCursor | void | Promise<SqlCursor | void>;
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

const runSql = async (executor: SqlExecutor, sql: string, ...bindings: SqlBinding[]): Promise<SqlCursor | void> => {
  const result = executor.exec(sql, ...bindings);
  if (result instanceof Promise) {
    // SAFETY: `executor.exec` resolves to a cursor or void.
    return (await result) as SqlCursor | void;
  }
  return result;
};

const rowsFrom = (raw: SqlCursor | void | readonly SqlRow[]): readonly SqlRow[] => {
  if (Array.isArray(raw)) {
    // SAFETY: Array.isArray narrowed this runtime value to an array.
    return raw as readonly SqlRow[];
  }
  // SAFETY: raw is not an array at this point, so it is only a cursor or void.
  const maybeCursor = raw as SqlCursor;
  if (maybeCursor !== undefined && maybeCursor !== null && maybeCursor.toArray instanceof Function) {
    return maybeCursor.toArray();
  }
  return [];
};

const CREATE_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS mackbot_audit (timestamp INTEGER NOT NULL, bot_id TEXT NOT NULL, kind TEXT NOT NULL, operation_id TEXT NOT NULL, detail TEXT)";

const SELECT_SQL =
  "SELECT timestamp, bot_id, kind, operation_id, detail FROM mackbot_audit ORDER BY timestamp ASC";

const INSERT_SQL =
  "INSERT INTO mackbot_audit (timestamp, bot_id, kind, operation_id, detail) VALUES (?, ?, ?, ?, ?)";

const AuditRowSchema = Schema.Struct({
  timestamp: Schema.Unknown,
  bot_id: Schema.Unknown,
  kind: Schema.Unknown,
  operation_id: Schema.Unknown,
  detail: Schema.optional(Schema.Json),
});

type JsonValue = Schema.Schema.Type<typeof Schema.Json>;

const parseDetail = (raw: SqlBinding | undefined): JsonValue => {
  if (!Predicate.isString(raw)) return raw === undefined ? null : (raw ?? null);
  // SAFETY: JSON.parse runtime failure is handled by returning the stored text.
  try {
    const parsed: JsonValue = JSON.parse(raw);
    return parsed;
  } catch {
    /* keep the raw string when it is not valid JSON */
    return raw;
  }
};

const rowToEvent = (row: SqlRow): AuditEvent => {
  const record = Schema.decodeUnknownSync(AuditRowSchema)(row);
  return {
    timestamp: Number(record.timestamp ?? 0),
    botId: String(record.bot_id ?? ""),
    kind: String(record.kind ?? ""),
    operationId: String(record.operation_id ?? ""),
    // SAFETY: AuditRowSchema marks detail as optional unknown; parseDetail narrows it at runtime.
    detail: parseDetail(record.detail as SqlBinding | undefined),
  };
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