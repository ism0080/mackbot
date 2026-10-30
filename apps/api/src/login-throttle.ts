/**
 * login-throttle - how many wrong tokens one client may try.
 *
 * `/login` is the one route that answers without a credential, so it is the
 * one a guesser can hammer. Each client (the caller's IP, as Cloudflare
 * reports it) gets {@link LOGIN_FAILURE_LIMIT} failures per
 * {@link LOGIN_WINDOW_MS}; after that every attempt, right or wrong, is refused
 * until the window that started with its first failure has passed. A success
 * clears the client's count.
 *
 * The counts live in one Durable Object's SQLite, so every isolate shares them.
 * Rows from windows that have passed are deleted on every write, which keeps
 * the table to the clients that failed recently.
 */

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { read, write } from "./sql.ts";
import type { SqlStorage } from "./sql.ts";

export const LOGIN_FAILURE_LIMIT = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const CREATE_TABLE =
  "CREATE TABLE IF NOT EXISTS mackbot_login_failures (client TEXT PRIMARY KEY, failures INTEGER NOT NULL, window_start INTEGER NOT NULL)";

const FailureRowSchema = Schema.Struct({ failures: Schema.Number, window_start: Schema.Number });
const decodeFailureRow = Schema.decodeUnknownOption(FailureRowSchema);

export interface LoginThrottle {
  /** Seconds until `client` may try again, or `undefined` when it may try now. */
  readonly retryAfter: (client: string, now: number) => number | undefined;
  readonly recordFailure: (client: string, now: number) => void;
  readonly clear: (client: string) => void;
}

export const createLoginThrottle = (storage: SqlStorage): LoginThrottle => {
  write(storage.sql, CREATE_TABLE);
  const prune = (now: number): void => {
    write(
      storage.sql,
      "DELETE FROM mackbot_login_failures WHERE window_start <= ?",
      now - LOGIN_WINDOW_MS,
    );
  };
  return {
    retryAfter: (client, now) => {
      const rows = read(
        storage.sql,
        "SELECT failures, window_start FROM mackbot_login_failures WHERE client = ? AND window_start > ?",
        client,
        now - LOGIN_WINDOW_MS,
      );
      return Option.match(decodeFailureRow(rows[0]), {
        onNone: () => undefined,
        onSome: (row) =>
          row.failures < LOGIN_FAILURE_LIMIT
            ? undefined
            : Math.max(1, Math.ceil((row.window_start + LOGIN_WINDOW_MS - now) / 1000)),
      });
    },
    recordFailure: (client, now) => {
      prune(now);
      write(
        storage.sql,
        "INSERT INTO mackbot_login_failures (client, failures, window_start) VALUES (?, 1, ?) ON CONFLICT(client) DO UPDATE SET failures = failures + 1",
        client,
        now,
      );
    },
    clear: (client) => {
      write(storage.sql, "DELETE FROM mackbot_login_failures WHERE client = ?", client);
    },
  };
};
