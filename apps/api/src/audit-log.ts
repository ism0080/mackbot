/**
 * audit-log — the `mackbot_audit` table: one row per thing a bot was asked to
 * do and how it settled.
 *
 * The table is append-only apart from retention: rows older than
 * {@link AUDIT_RETENTION_MS} are pruned, because a Durable Object's storage is
 * not a log archive and nothing reads a trail that old.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { toJson } from "./json.ts";
import { read, write } from "./sql.ts";
import type { SqlExecutor, SqlStorage } from "./sql.ts";
import { currentTimeMillis } from "./clock.ts";

export const AuditEventSchema = Schema.Struct({
  timestamp: Schema.Number,
  botId: Schema.String,
  kind: Schema.String,
  operationId: Schema.String,
  detail: Schema.Json,
});

export type AuditEvent = Schema.Schema.Type<typeof AuditEventSchema>;

/** How long an audit row is kept: thirty days. */
export const AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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

const CREATE_TIMESTAMP_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS mackbot_audit_timestamp ON mackbot_audit (timestamp)";

const INSERT_SQL =
  "INSERT INTO mackbot_audit (timestamp, bot_id, kind, operation_id, detail) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING";

const PRUNE_SQL = "DELETE FROM mackbot_audit WHERE timestamp < ? RETURNING timestamp";

export type AuditLog = {
  /** Record one event. Rejects when the event or the write is invalid. */
  readonly append: (event: AuditEvent) => Promise<void>;
  /**
   * Delete every row older than `cutoff`, a timestamp in milliseconds, and say
   * how many went. Defaults to {@link AUDIT_RETENTION_MS} before now.
   */
  readonly prune: (cutoff?: number) => number;
};

export const createAuditLog = (storage: SqlStorage): AuditLog => {
  const executor: SqlExecutor = storage.sql;
  let migrated = false;

  // The table is created lazily and idempotently, because a fresh isolate can
  // prune before it appends.
  const ensureMigrated = (): void => {
    if (migrated) return;
    write(executor, CREATE_TABLE_SQL);
    write(executor, CREATE_SETTLEMENT_INDEX_SQL);
    write(executor, CREATE_TIMESTAMP_INDEX_SQL);
    migrated = true;
  };

  const append = (event: AuditEvent): Promise<void> =>
    Effect.runPromise(
      Schema.decodeUnknownEffect(AuditEventSchema)(event).pipe(
        Effect.flatMap((validated) =>
          Effect.try({
            try: () => {
              ensureMigrated();
              write(
                executor,
                INSERT_SQL,
                validated.timestamp,
                validated.botId,
                validated.kind,
                validated.operationId,
                toJson(validated.detail),
              );
            },
            catch: (cause) => cause,
          }),
        ),
      ),
    );

  const prune = (cutoff: number = currentTimeMillis() - AUDIT_RETENTION_MS): number => {
    ensureMigrated();
    return read(executor, PRUNE_SQL, cutoff).length;
  };

  return { append, prune };
};
