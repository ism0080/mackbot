/**
 * A Durable Object's SQLite seam over `bun:sqlite`, for the smoke tests that
 * exercise the `mackbot_*` stores against real SQL. The shape mirrors
 * `src/sql.ts`'s `SqlStorage`: a synchronous `exec` whose cursor has `toArray`.
 */
export const sqliteStorage = (database) => ({
  sql: {
    exec: (query, ...bindings) => {
      const statement = database.query(query);
      if (statement.columnNames.length > 0) {
        return { toArray: () => statement.all(...bindings) };
      }
      statement.run(...bindings);
      return { toArray: () => [] };
    },
  },
});
