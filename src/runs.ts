/**
 * runs — the `mackbot_runs` table and the join that dates a transcript entry.
 *
 * pi's `EntryRecord` has a monotonic numeric id and no timestamp, so the only
 * way to render `09:41` on an entry is to record the wall-clock window each run
 * occupied and attribute entries to it by id. A run's window is
 * `[start_entry, end_entry]`: `start_entry` is the conversation's high-water
 * entry id at admission plus one, so no earlier entry can fall inside it, and
 * `end_entry` is the high-water id at settlement. Entries in no window keep no
 * `at` — that is pi's pre-existing history, which mackbot did not witness.
 *
 * A run whose settlement nobody observed is closed by the next run's admission,
 * at the id just before that run's window. A session runs one submission at a
 * time, so a settled run's window is exact; when a later run is admitted while
 * an earlier one is still producing, the two windows overlap and the newer one
 * wins the boundary.
 */

import { Option, Schema } from "effect";

import { read, write } from "./sql.ts";
import type { SqlExecutor, SqlRow, SqlStorage } from "./sql.ts";
import type { StreamStatusView } from "@mackbot/contract";

/** One run, as `mackbot_runs` records it. */
export interface RunRow {
  readonly ordinal: number;
  readonly sessionId: string;
  readonly operationId: string;
  readonly streamId: string;
  readonly inputs: readonly string[];
  readonly startedAt: number;
  readonly settledAt?: number;
  readonly startEntry: number;
  readonly endEntry?: number;
  readonly status: "running" | "completed";
}

/** A run as it is admitted, before its ordinal and stream name are assigned. */
export interface OpenRun {
  readonly sessionId: string;
  readonly operationId: string;
  readonly inputs: readonly string[];
  readonly startedAt: number;
  /** The conversation's high-water entry id at admission, plus one. */
  readonly startEntry: number;
}

export interface RunSettlement {
  readonly sessionId: string;
  readonly operationId: string;
  readonly endEntry: number;
  readonly settledAt: number;
}

/** What the active run's stream is called. */
export const streamIdFor = (sessionId: string, ordinal: number): string =>
  `feed:${sessionId}:${ordinal}`;

/**
 * The run an entry belongs to: the newest window that contains the id. Windows
 * can overlap only while an unresolved earlier run is open, and the newest is
 * the right owner there.
 */
export const runForEntry = (entryId: number, runs: readonly RunRow[]): RunRow | undefined => {
  let chosen: RunRow | undefined;
  for (const run of runs) {
    if (!contains(run, entryId)) continue;
    if (chosen === undefined || run.ordinal > chosen.ordinal) chosen = run;
  }
  return chosen;
};

const contains = (run: RunRow, entryId: number): boolean =>
  entryId >= run.startEntry && (run.endEntry === undefined || entryId <= run.endEntry);

/** Where a client attaches the live tail: the newest run's stream. */
export const streamViewOf = (
  sessionId: string,
  run: RunRow | undefined,
  cursor: number,
): StreamStatusView =>
  run === undefined
    ? { stream: streamIdFor(sessionId, 0), generation: 0, cursor: 0, state: "completed" }
    : {
        stream: run.streamId,
        generation: run.ordinal,
        cursor,
        state: run.status === "running" ? "streaming" : "completed",
      };

const COLUMNS =
  "ordinal, session_id, operation_id, stream_id, inputs, started_at, settled_at, start_entry, end_entry, status";

const CREATE_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS mackbot_runs (ordinal INTEGER NOT NULL, session_id TEXT NOT NULL, operation_id TEXT NOT NULL, stream_id TEXT NOT NULL, inputs TEXT NOT NULL, started_at INTEGER NOT NULL, settled_at INTEGER, start_entry INTEGER NOT NULL, end_entry INTEGER, status TEXT NOT NULL, PRIMARY KEY (session_id, ordinal))";

/**
 * Admission is idempotent on the operation id, so a replayed submission is one
 * run window, not two.
 */
const CREATE_OPERATION_INDEX_SQL =
  "CREATE UNIQUE INDEX IF NOT EXISTS mackbot_runs_operation ON mackbot_runs (session_id, operation_id)";

const NEXT_ORDINAL_SQL =
  "SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM mackbot_runs WHERE session_id = ?";

// `operation_id <> ?` keeps a replayed admission from closing the window the
// replay belongs to.
const CLOSE_OPEN_SQL =
  "UPDATE mackbot_runs SET end_entry = ?, settled_at = ?, status = 'completed' WHERE session_id = ? AND end_entry IS NULL AND operation_id <> ?";

const INSERT_SQL =
  "INSERT OR IGNORE INTO mackbot_runs (ordinal, session_id, operation_id, stream_id, inputs, started_at, start_entry, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'running')";

const SETTLE_SQL =
  "UPDATE mackbot_runs SET end_entry = ?, settled_at = ?, status = 'completed' WHERE session_id = ? AND operation_id = ? AND end_entry IS NULL";

const LIST_SQL = `SELECT ${COLUMNS} FROM mackbot_runs ORDER BY session_id, ordinal`;

const RunRecordSchema = Schema.Struct({
  ordinal: Schema.Number,
  session_id: Schema.String,
  operation_id: Schema.String,
  stream_id: Schema.String,
  inputs: Schema.String,
  started_at: Schema.Number,
  settled_at: Schema.NullOr(Schema.Number),
  start_entry: Schema.Number,
  end_entry: Schema.NullOr(Schema.Number),
  status: Schema.Literals(["running", "completed"]),
});

const InputList = Schema.fromJsonString(Schema.Array(Schema.String));

const NextOrdinalSchema = Schema.Struct({ next: Schema.Number });

const rowToRun = (row: SqlRow): Option.Option<RunRow> =>
  Option.map(Schema.decodeUnknownOption(RunRecordSchema)(row), (record) => ({
    ordinal: record.ordinal,
    sessionId: record.session_id,
    operationId: record.operation_id,
    streamId: record.stream_id,
    inputs: Option.getOrElse(Schema.decodeUnknownOption(InputList)(record.inputs), () => []),
    startedAt: record.started_at,
    settledAt: record.settled_at ?? undefined,
    startEntry: record.start_entry,
    endEntry: record.end_entry ?? undefined,
    status: record.status,
  }));

export type RunStore = {
  readonly open: (run: OpenRun) => void;
  readonly settle: (settlement: RunSettlement) => void;
  readonly list: () => readonly RunRow[];
};

export function createRunStore(storage: SqlStorage): RunStore {
  const executor: SqlExecutor = storage.sql;
  let migrated = false;

  // Every entry point runs the DDL, because a fresh isolate can read before it
  // writes and the tables are created lazily.
  const ensureMigrated = (): void => {
    if (migrated) return;
    write(executor, CREATE_TABLE_SQL);
    write(executor, CREATE_OPERATION_INDEX_SQL);
    migrated = true;
  };

  const nextOrdinal = (sessionId: string): number => {
    const [row] = read(executor, NEXT_ORDINAL_SQL, sessionId);
    const decoded = Schema.decodeUnknownOption(NextOrdinalSchema)(row);
    return Option.getOrElse(decoded, () => ({ next: 1 })).next;
  };

  const open = (run: OpenRun): void => {
    ensureMigrated();
    const ordinal = nextOrdinal(run.sessionId);
    write(
      executor,
      CLOSE_OPEN_SQL,
      run.startEntry - 1,
      run.startedAt,
      run.sessionId,
      run.operationId,
    );
    write(
      executor,
      INSERT_SQL,
      ordinal,
      run.sessionId,
      run.operationId,
      streamIdFor(run.sessionId, ordinal),
      JSON.stringify(run.inputs),
      run.startedAt,
      run.startEntry,
    );
  };

  const settle = (settlement: RunSettlement): void => {
    ensureMigrated();
    write(
      executor,
      SETTLE_SQL,
      settlement.endEntry,
      settlement.settledAt,
      settlement.sessionId,
      settlement.operationId,
    );
  };

  const list = (): readonly RunRow[] => {
    ensureMigrated();
    return read(executor, LIST_SQL).flatMap((row) => Option.toArray(rowToRun(row)));
  };

  return { open, settle, list };
}
