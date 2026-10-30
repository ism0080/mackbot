import { DatabaseSync } from "node:sqlite";

import type { SqlCursor, SqlRow, SqlStorage, SqlValue } from "../../src/sql.ts";

/**
 * An in-memory SQLite database behind the same `{ sql: { exec } }` seam a
 * Durable Object's `ctx.storage` offers, so a store runs here exactly as it
 * runs in production. `db` is the raw handle, for a test to read or write a
 * table the store under test does not expose.
 */
export const memoryStorage = (): SqlStorage & { readonly db: DatabaseSync } => {
  const db = new DatabaseSync(":memory:");
  const exec = (query: string, ...bindings: SqlValue[]): SqlCursor | undefined => {
    const statement = db.prepare(query);
    // SAFETY: the stores bind only strings, numbers and null.
    const values = bindings as Array<string | number | null>;
    if (statement.columns().length === 0) {
      statement.run(...values);
      return undefined;
    }
    // SAFETY: a SQLite row is a record of column values, which is what SqlRow is.
    const rows = statement.all(...values) as readonly SqlRow[];
    return { toArray: () => rows };
  };
  return { sql: { exec }, db };
};
