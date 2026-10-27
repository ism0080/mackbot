/**
 * A Durable Object's SQLite storage, over bun:sqlite.
 *
 * pi's Durable Object adapter needs `ctx.storage.sql` with bindings, a cursor
 * that answers `next` and `toArray`, and `ctx.storage.transaction`. bun:sqlite
 * is synchronous and has none of those shapes, so this stands in for them.
 *
 * The shape is the same one `tests/support/sqlite.mjs` gives mackbot's own
 * tables, with the two pieces the pi adapter needs added.
 */
import { Database } from "bun:sqlite";

/** A Durable Object's SQLite storage, over an open bun:sqlite database. */
export const durableStorage = (database) => ({
  sql: {
    exec: (query, ...bindings) => {
      const statement = database.query(query);
      if (statement.columnNames.length > 0) {
        const rows = statement.all(...bindings);
        let index = 0;
        return {
          next: () =>
            index < rows.length
              ? { done: false, value: rows[index++] }
              : { done: true, value: undefined },
          toArray: () => rows,
        };
      }
      statement.run(...bindings);
      return { next: () => ({ done: true, value: undefined }), toArray: () => [] };
    },
  },
  transaction: async (closure) => {
    database.exec("BEGIN");
    try {
      const result = await closure();
      database.exec("COMMIT");
      return result;
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    }
  },
});

/** A fresh database in a temporary directory, and the directory holding it. */
export const temporaryDatabase = (directory, name) => {
  const database = new Database(`${directory}/${name}`, { create: true });
  return database;
};
