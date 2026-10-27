/**
 * sql — the structural SQLite seam the mackbot tables read and write through.
 *
 * The stores in this directory take this shape rather than the Workers
 * `SqlStorage` type, so the same code runs against a Durable Object's SQLite in
 * production and against `bun:sqlite` in tests with no cast in either. Rows
 * come back `unknown` and are parsed with the Schema each store wrote them
 * with.
 */

export type SqlValue = string | number | null | ArrayBuffer;

/** One row as SQLite hands it back, before Schema parses it. */
export type SqlRow = { [key: string]: SqlValue };

export interface SqlCursor {
  toArray(): readonly SqlRow[];
}

export interface SqlExecutor {
  exec(query: string, ...bindings: SqlValue[]): SqlCursor | undefined;
}

/** A Durable Object's `ctx.storage`. */
export interface SqlStorage {
  readonly sql: SqlExecutor;
}

export const read = (
  executor: SqlExecutor,
  query: string,
  ...bindings: SqlValue[]
): readonly SqlRow[] => {
  const result = executor.exec(query, ...bindings);
  return result === undefined ? [] : result.toArray();
};

export const write = (executor: SqlExecutor, query: string, ...bindings: SqlValue[]): void => {
  executor.exec(query, ...bindings);
};
