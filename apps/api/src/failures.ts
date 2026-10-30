/**
 * failures — the `mackbot_failures` table and the shape of one reported failure.
 *
 * The Harness reports what it could not recover from: a throwing hook, a
 * faulted tool call, a Session that stopped. This table keeps the last of
 * them, in the shape `/status` already publishes, so an operator can read
 * what the harness said.
 *
 * The harness names the failure itself. `ReportInfo.type` says whether a task
 * was parked or a session failed, and those are different problems wanting
 * different responses, so the store keeps pi's word instead of guessing one
 * from the error.
 *
 * The store is synchronous, because a Durable Object's `ctx.storage.sql.exec`
 * is, and `record` never throws: it runs in the harness's own failure path,
 * where a second failure would hide the first.
 */

import type { ReportInfo, ReportTask } from "@earendil-works/pi-durable";
import { Effect, Option, Predicate, Schema } from "effect";

import { describeCause } from "./errors.ts";
import { read, write } from "./sql.ts";
import type { SqlExecutor, SqlRow, SqlStorage, SqlValue } from "./sql.ts";
import { FailureViewSchema } from "@mackbot/contract";
import type { FailureView } from "@mackbot/contract";

/** The detail's cap, marker included. */
const MAX_DETAIL = 500;

const TRUNCATION_MARKER = "...";

/** The harness's own word for a failure. */
export type FailureKind = ReportInfo["type"];

export type FailureStore = {
  /** Record one harness failure. Never throws. */
  readonly record: (cause: unknown, info: ReportInfo) => void;
  /** The most recent failures, newest first. */
  readonly recent: (limit?: number) => readonly FailureView[];
  /**
   * Delete every failure older than `cutoff`, a timestamp in milliseconds,
   * and say how many went. Defaults to {@link FAILURE_RETENTION_MS} before now.
   */
  readonly prune: (cutoff?: number) => number;
};

/**
 * How long a failure is kept: seven days. `/status` shows the newest few, and
 * a failure a week old has either been dealt with or been reported again.
 */
export const FAILURE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The harness's own word for a failure, and the human-readable shape of it. */
export type ClassifiedFailure = {
  readonly kind: FailureKind;
  readonly name: string;
  readonly detail: string;
  readonly taskId?: string;
  readonly taskKind?: string;
  readonly extension?: string;
  readonly callback?: string;
};

/**
 * The cause's own name, so a reader can tell a `TypeError` from a
 * `RangeError`. A value that is not an error is reported as an unnamed
 * `Error`.
 */
const nameOf = (cause: unknown): string => {
  if (!(cause instanceof Error)) return "Error";
  return Predicate.isString(cause.name) ? cause.name : "Error";
};

const truncate = (message: string): string =>
  message.length > MAX_DETAIL
    ? `${message.slice(0, MAX_DETAIL - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`
    : message;

/**
 * The task a report is about. Its id is a branded number, so it is published
 * as the string the view carries; a report about no task carries neither.
 */
const taskFields = (
  task: ReportTask | undefined,
): { readonly taskId?: string; readonly taskKind?: string } =>
  task === undefined ? {} : { taskId: String(task.id), taskKind: task.kind };

/**
 * The harness's own word for a failure, and the human-readable shape of it.
 *
 * `info` decides the kind, because the harness is the only one that knows
 * whether a task was parked or a session failed. Each arm of the switch knows
 * the shape of its own variant, so no arm has to guess which fields exist.
 */
export const classifyFailure = (cause: unknown, info: ReportInfo): ClassifiedFailure => {
  const base = { name: nameOf(cause), detail: truncate(describeCause(cause)) };
  switch (info.type) {
    case "session_failed":
      return { kind: info.type, ...base };
    case "task_faulted":
      return { kind: info.type, ...base, ...taskFields(info.task), extension: info.extension };
    case "task_parked":
      return { kind: info.type, ...base, ...taskFields(info.task), extension: info.extension };
    case "migration_failed":
      return { kind: info.type, ...base, ...taskFields(info.task), extension: info.extension };
    case "task_outdated":
      return { kind: info.type, ...base, ...taskFields(info.task), extension: info.extension };
    case "task_error":
      return { kind: info.type, ...base, ...taskFields(info.task), extension: info.extension };
    case "extension_error":
      return { kind: info.type, ...base, ...taskFields(info.task), extension: info.extension };
    case "host_error":
      return { kind: info.type, ...base, ...taskFields(info.task), callback: info.callback };
    case "listener_error":
      return { kind: info.type, ...base };
  }
};

const CREATE_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS mackbot_failures (at INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, detail TEXT NOT NULL, task_id TEXT, task_kind TEXT, extension TEXT, callback TEXT)";

const CREATE_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS mackbot_failures_at ON mackbot_failures (at DESC)";

const INSERT_SQL =
  "INSERT INTO mackbot_failures (at, kind, name, detail, task_id, task_kind, extension, callback) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

// `rowid` breaks a tie between two failures reported in the same millisecond,
// so "newest first" holds for equal timestamps too.
const LIST_SQL =
  "SELECT at, kind, name, detail, task_id, task_kind, extension, callback FROM mackbot_failures ORDER BY at DESC, rowid DESC LIMIT ?";

const PRUNE_SQL = "DELETE FROM mackbot_failures WHERE at < ? RETURNING at";

// A negative LIMIT means "no limit" in SQLite, which would defeat the cap.
const boundedLimit = (limit: number): number =>
  Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;

/** A nullable text column, absent when the column holds null. */
const textOf = (value: SqlValue): string | undefined =>
  value === null ? undefined : String(value);

const rowToFailure = (row: SqlRow): Option.Option<FailureView> =>
  Schema.decodeUnknownOption(FailureViewSchema)({
    at: row.at,
    kind: row.kind,
    name: row.name,
    detail: row.detail,
    taskId: textOf(row.task_id),
    taskKind: textOf(row.task_kind),
    extension: textOf(row.extension),
    callback: textOf(row.callback),
  });

export const createFailureStore = (storage: SqlStorage): FailureStore => {
  const executor: SqlExecutor = storage.sql;
  let migrated = false;

  // The table is created lazily, so a bot that already ran the previous
  // revision has it without the task columns. `ADD COLUMN` has no
  // `IF NOT EXISTS`, so the current shape is read first.
  const addColumns = (names: readonly string[]): void => {
    const present = read(executor, "PRAGMA table_info(mackbot_failures)").map((row) => row.name);
    for (const name of names) {
      if (present.includes(name)) continue;
      write(executor, `ALTER TABLE mackbot_failures ADD COLUMN ${name} TEXT`);
    }
  };

  // The table is created lazily and idempotently, because a fresh isolate can
  // read before it writes.
  const ensureMigrated = (): void => {
    if (migrated) return;
    write(executor, CREATE_TABLE_SQL);
    addColumns(["task_id", "task_kind", "extension", "callback"]);
    write(executor, CREATE_INDEX_SQL);
    migrated = true;
  };

  const record = (cause: unknown, info: ReportInfo): void => {
    Effect.runSync(
      Effect.try(() => {
        const failure = classifyFailure(cause, info);
        ensureMigrated();
        write(
          executor,
          INSERT_SQL,
          Date.now(),
          failure.kind,
          failure.name,
          failure.detail,
          failure.taskId ?? null,
          failure.taskKind ?? null,
          failure.extension ?? null,
          failure.callback ?? null,
        );
      }).pipe(Effect.ignore),
    );
  };

  const recent = (limit = 20): readonly FailureView[] => {
    ensureMigrated();
    return read(executor, LIST_SQL, boundedLimit(limit)).flatMap((row) =>
      Option.toArray(rowToFailure(row)),
    );
  };

  const prune = (cutoff: number = Date.now() - FAILURE_RETENTION_MS): number => {
    ensureMigrated();
    return read(executor, PRUNE_SQL, cutoff).length;
  };

  return { record, recent, prune };
};
