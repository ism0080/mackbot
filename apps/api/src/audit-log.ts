import { Effect, Option, Predicate, Schema } from "effect";

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

const runSql = async (
  executor: SqlExecutor,
  sql: string,
  ...bindings: SqlBinding[]
): Promise<SqlCursor | void> => {
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
  if (
    maybeCursor !== undefined &&
    maybeCursor !== null &&
    maybeCursor.toArray instanceof Function
  ) {
    return maybeCursor.toArray();
  }
  return [];
};

const CREATE_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS mackbot_audit (timestamp INTEGER NOT NULL, bot_id TEXT NOT NULL, kind TEXT NOT NULL, operation_id TEXT NOT NULL, detail TEXT)";

/**
 * One settlement per operation. An operation settles once, but `wait` can have
 * several observers, so two clients long-polling the same operation would
 * otherwise record the same settlement twice. The index covers settled rows only,
 * so replays stay a count of how often a client retried.
 */
const CREATE_SETTLEMENT_INDEX_SQL =
  "CREATE UNIQUE INDEX IF NOT EXISTS mackbot_audit_settlement ON mackbot_audit (operation_id, kind) WHERE kind LIKE 'settlement.%'";

const SELECT_COLUMNS = "timestamp, bot_id, kind, operation_id, detail";
const SELECT_ALL_SQL = `SELECT ${SELECT_COLUMNS} FROM mackbot_audit ORDER BY timestamp ASC`;
const SELECT_RECENT_SQL = `SELECT ${SELECT_COLUMNS} FROM (SELECT ${SELECT_COLUMNS} FROM mackbot_audit ORDER BY timestamp DESC LIMIT ?) ORDER BY timestamp ASC`;

const INSERT_SQL =
  "INSERT INTO mackbot_audit (timestamp, bot_id, kind, operation_id, detail) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING";

const AuditRowSchema = Schema.Struct({
  timestamp: Schema.Unknown,
  bot_id: Schema.Unknown,
  kind: Schema.Unknown,
  operation_id: Schema.Unknown,
  detail: Schema.optional(Schema.Json),
});

type JsonValue = Schema.Schema.Type<typeof Schema.Json>;

const JsonFromText = Schema.fromJsonString(Schema.Json);

const parseDetail = (raw: SqlBinding | undefined): JsonValue => {
  if (!Predicate.isString(raw)) return raw ?? null;
  // Keep the stored text when it is not valid JSON instead of throwing.
  return Option.getOrElse(Schema.decodeUnknownOption(JsonFromText)(raw), () => raw);
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

  const migrate = async (): Promise<void> => {
    await runSql(executor, CREATE_TABLE_SQL);
    await runSql(executor, CREATE_SETTLEMENT_INDEX_SQL);
  };

  let migration: Promise<void> | undefined;
  const ensureMigrated = (): Promise<void> => {
    migration ??= migrate().catch((cause: unknown) => {
      // Let the next caller retry instead of caching a rejected migration.
      migration = undefined;
      throw cause;
    });
    return migration;
  };

  const append = async (event: AuditEvent): Promise<void> => {
    const validated = Schema.decodeUnknownSync(AuditEventSchema)(event);
    await ensureMigrated();
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
    await ensureMigrated();
    const raw =
      limit === undefined
        ? await runSql(executor, SELECT_ALL_SQL)
        : await runSql(executor, SELECT_RECENT_SQL, limit);
    return rowsFrom(raw).map(rowToEvent);
  };

  // Best-effort table creation up front; harmless if the storage is lazy.
  void ensureMigrated().catch(() => undefined);

  return { append, list, migrate };
}
