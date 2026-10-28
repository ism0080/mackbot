/**
 * threads - which conversation a browser thread is.
 *
 * A thread id is the browser's name for one conversation; pi knows only
 * conversation ids. The mapping lives in a Session-scoped pi document, so the
 * browser's name and the conversation it names are committed together: the
 * write happens inside the commit that creates the conversation (see
 * `conversationCreated` in `#makeHarnessFactory`), never after it. A crash
 * between the two is impossible, and a conversation cannot be left without the
 * thread that named it.
 *
 * A Session document is latest-only by construction: only conversation
 * documents declare history and fork behaviour, because only they are forked.
 */

import { defineDoc } from "@earendil-works/pi-durable";
import type { Tx } from "@earendil-works/pi-durable";

import { read } from "./sql.ts";
import type { SqlStorage } from "./sql.ts";

/** Thread id → pi conversation id, as strings on both sides of the wire. */
export type ThreadSessions = { threads: Record<string, string> };

/**
 * The thread map of this bot.
 *
 * `checkpointWhen` is false: the map is small, and a checkpoint would store the
 * same value again rather than bound anything.
 */
export const ThreadsDoc = defineDoc<ThreadSessions>({
  kind: "mackbot.threads",
  version: 1,
  scope: "session",
  initial: () => ({ threads: {} }),
  checkpointWhen: () => false,
});

/**
 * Record `thread` as `session` in the transaction that creates `session`.
 *
 * Called from a conversation-creation hook, so the value is staged in the
 * creating commit: either both the conversation and this mapping exist, or
 * neither does.
 */
export const recordThread = async (tx: Tx, thread: string, session: string): Promise<void> => {
  const threads = await tx.doc(ThreadsDoc);
  threads.threads[thread] = session;
};

/**
 * The session a thread was recorded as before the document existed.
 *
 * Read-only: a thread created now is recorded in {@link ThreadsDoc}'s commit,
 * and this table only answers for threads an older isolate created.
 */
export const legacyThreadSession = (storage: SqlStorage, thread: string): string | undefined => {
  const rows = read(storage.sql, "SELECT session_id FROM mackbot_threads WHERE thread = ?", thread);
  const value = rows[0]?.session_id;
  return value === undefined || value === null ? undefined : String(value);
};
