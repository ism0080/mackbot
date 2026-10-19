/**
 * failures — the `mackbot_failures` table and the shape of one reported failure.
 *
 * The Harness reports what it could not recover from: a throwing hook, a
 * faulted tool call, a Session that stopped. mackbot opens the Harness without
 * an `onReport`, so those faults leave the operator nothing to read; this
 * table keeps the last of them, in the shape `/status` already publishes.
 *
 * The store is synchronous, because a Durable Object's `ctx.storage.sql.exec`
 * is, and `record` never throws: it runs in the harness's own failure path,
 * where a second failure would hide the first.
 */

import { SessionFailed } from "@earendil-works/pi-durable";
import { Effect, Option, Predicate, Schema } from "effect";

import { read, write } from "./sql.ts";
import type { SqlExecutor, SqlRow, SqlStorage } from "./sql.ts";
import { FailureViewSchema } from "./web-contract.ts";
import type { FailureView } from "./web-contract.ts";

/** The detail's cap, marker included. */
const MAX_DETAIL = 500;

const TRUNCATION_MARKER = "...";

export type FailureStore = {
  /** Record one harness failure. Never throws. */
  readonly record: (cause: unknown) => void;
  /** The most recent failures, newest first. */
  readonly recent: (limit?: number) => readonly FailureView[];
  /** Forget every recorded failure. */
  readonly clear: () => void;
};

/** The bucket and the human-readable shape of one reported failure. */
export type ClassifiedFailure = {
  readonly kind: "session_failed" | "harness_failure";
  readonly name: string;
  readonly detail: string;
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

/** The message of an error, or of the value itself when it is not an error. */
const messageOf = (cause: unknown): string => {
  if (cause instanceof Error && Predicate.isString(cause.message)) return cause.message;
  // `String()` throws for a value with a null prototype, and a failure report
  // must not fail while it formats the failure.
  return Effect.runSync(
    Effect.try(() => String(cause)).pipe(
      Effect.orElseSucceed(() => Object.prototype.toString.call(cause)),
    ),
  );
};

const truncate = (message: string): string =>
  message.length > MAX_DETAIL
    ? `${message.slice(0, MAX_DETAIL - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`
    : message;

/** The bucket and the human-readable shape of one reported failure. */
export const classifyFailure = (cause: unknown): ClassifiedFailure => ({
  kind: cause instanceof SessionFailed ? "session_failed" : "harness_failure",
  name: nameOf(cause),
  detail: truncate(messageOf(cause)),
});

const CREATE_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS mackbot_failures (at INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, detail TEXT NOT NULL)";

const CREATE_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS mackbot_failures_at ON mackbot_failures (at DESC)";

const INSERT_SQL = "INSERT INTO mackbot_failures (at, kind, name, detail) VALUES (?, ?, ?, ?)";

// `rowid` breaks a tie between two failures reported in the same millisecond,
// so "newest first" holds for equal timestamps too.
const LIST_SQL =
  "SELECT at, kind, name, detail FROM mackbot_failures ORDER BY at DESC, rowid DESC LIMIT ?";

const CLEAR_SQL = "DELETE FROM mackbot_failures";

// A negative LIMIT means "no limit" in SQLite, which would defeat the cap.
const boundedLimit = (limit: number): number =>
  Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;

const rowToFailure = (row: SqlRow): Option.Option<FailureView> =>
  Schema.decodeUnknownOption(FailureViewSchema)(row);

export const createFailureStore = (storage: SqlStorage): FailureStore => {
  const executor: SqlExecutor = storage.sql;
  let migrated = false;

  // The table is created lazily and idempotently, because a fresh isolate can
  // read before it writes.
  const ensureMigrated = (): void => {
    if (migrated) return;
    write(executor, CREATE_TABLE_SQL);
    write(executor, CREATE_INDEX_SQL);
    migrated = true;
  };

  const record = (cause: unknown): void => {
    const failure = classifyFailure(cause);
    Effect.runSync(
      Effect.try(() => {
        ensureMigrated();
        write(executor, INSERT_SQL, Date.now(), failure.kind, failure.name, failure.detail);
      }).pipe(Effect.ignore),
    );
  };

  const recent = (limit = 20): readonly FailureView[] => {
    ensureMigrated();
    return read(executor, LIST_SQL, boundedLimit(limit)).flatMap((row) =>
      Option.toArray(rowToFailure(row)),
    );
  };

  const clear = (): void => {
    ensureMigrated();
    write(executor, CLEAR_SQL);
  };

  return { record, recent, clear };
};
