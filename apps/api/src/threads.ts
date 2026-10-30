/**
 * threads - which conversation a browser thread is, and what the list of a
 * bot's conversations says about each one.
 *
 * A thread id is the browser's name for one conversation; pi knows only
 * conversation ids. The mapping lives in a Session-scoped pi document, so the
 * browser's name and the conversation it names are committed together: the
 * write happens inside the commit that creates the conversation (the `init`
 * of `createConversation` in `Bot`'s thread-session creation), never after
 * it. A crash between the two is impossible, a conversation cannot be left
 * without the thread that named it, and only the conversation created for the
 * thread can be recorded as it.
 *
 * The same document holds what the conversation list shows of each
 * conversation - its title, when it started, when it last took input, and
 * whether it is archived - keyed by pi's conversation id, so the root
 * conversation and a thread an older isolate filed in the legacy table get
 * the same record as a thread created now. pi commits no timestamp with an
 * entry, so these times are the only ones there are.
 *
 * A Session document is latest-only by construction: only conversation
 * documents declare history and fork behaviour, because only they are forked.
 */

import { defineDoc } from "@earendil-works/pi-durable";
import type { JsonObject, Tx } from "@earendil-works/pi-durable";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { THREAD_TITLE_MAX } from "@mackbot/contract";
import type { ThreadUpdate, ThreadView } from "@mackbot/contract";

import { read } from "./sql.ts";
import type { SqlStorage } from "./sql.ts";

/**
 * What the conversation list knows about one conversation. `null` is a fact
 * mackbot never recorded: the root has no title, and a conversation that
 * predates the record has no times.
 */
export type ConversationMeta = {
  title: string | null;
  createdAt: number | null;
  lastActivityAt: number | null;
  archived: boolean;
};

/**
 * Thread id → pi conversation id, as strings on both sides of the wire, and
 * pi conversation id → what the list shows of it.
 */
export type ThreadSessions = {
  threads: Record<string, string>;
  sessions: Record<string, ConversationMeta>;
};

const ConversationMetaSchema = Schema.Struct({
  title: Schema.NullOr(Schema.String),
  createdAt: Schema.NullOr(Schema.Number),
  lastActivityAt: Schema.NullOr(Schema.Number),
  archived: Schema.Boolean,
});

const ThreadSessionsSchema = Schema.Struct({
  threads: Schema.Record(Schema.String, Schema.String),
  sessions: Schema.optional(Schema.Record(Schema.String, ConversationMetaSchema)),
});

const emptyThreadSessions = (): ThreadSessions => ({ threads: {}, sessions: {} });

/**
 * A stored value as this version reads it. Version 1 held the thread map
 * alone, so it gains an empty record per conversation; a value that does not
 * decode as either version starts empty rather than failing every read of the
 * bot's threads.
 */
export const migrateThreadSessions = (value: JsonObject, _fromVersion: number): ThreadSessions =>
  Option.match(Schema.decodeUnknownOption(ThreadSessionsSchema)(value), {
    onNone: emptyThreadSessions,
    onSome: (decoded) => ({
      threads: { ...decoded.threads },
      sessions: { ...decoded.sessions },
    }),
  });

/**
 * The thread map of this bot.
 *
 * `checkpointWhen` is false: the map is small, and a checkpoint would store the
 * same value again rather than bound anything.
 */
export const ThreadsDoc = defineDoc<ThreadSessions>({
  kind: "mackbot.threads",
  version: 2,
  scope: "session",
  initial: emptyThreadSessions,
  migrate: migrateThreadSessions,
  checkpointWhen: () => false,
});

const unrecorded = (): ConversationMeta => ({
  title: null,
  createdAt: null,
  lastActivityAt: null,
  archived: false,
});

const metaOf = (doc: ThreadSessions, session: string): ConversationMeta =>
  Object.hasOwn(doc.sessions, session) ? doc.sessions[session]! : unrecorded();

/**
 * A thread's title from the words it was started with: the first line that
 * says something, its whitespace collapsed, cut at a word where it can be and
 * marked with an ellipsis when it was cut.
 */
export const threadTitleOf = (text: string): string => {
  const line =
    text
      .split("\n")
      .map((candidate) => candidate.replaceAll(/\s+/gu, " ").trim())
      .find((candidate) => candidate.length > 0) ?? "";
  if (line.length <= THREAD_TITLE_MAX) return line;
  const cut = line.slice(0, THREAD_TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > THREAD_TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

/**
 * Record `thread` as `session` in the transaction that creates `session`.
 *
 * Called from the conversation's `init`, so the value is staged in the
 * creating commit: either both the conversation and this mapping exist, or
 * neither does. The first message names the thread and dates it.
 */
export const recordThread = async (
  tx: Tx,
  thread: string,
  session: string,
  firstText: string,
  at: number,
): Promise<void> => {
  const doc = await tx.doc(ThreadsDoc);
  doc.threads[thread] = session;
  doc.sessions[session] = {
    title: threadTitleOf(firstText),
    createdAt: at,
    lastActivityAt: at,
    archived: false,
  };
};

/** Note that `session` took input at `at`, for the list's ordering. */
export const recordActivity = async (tx: Tx, session: string, at: number): Promise<void> => {
  const doc = await tx.doc(ThreadsDoc);
  doc.sessions[session] = { ...metaOf(doc, session), lastActivityAt: at };
};

/** Archive, restore or rename the conversation `session` names. */
export const recordThreadUpdate = async (
  tx: Tx,
  session: string,
  update: ThreadUpdate,
): Promise<void> => {
  const doc = await tx.doc(ThreadsDoc);
  const meta = metaOf(doc, session);
  doc.sessions[session] = {
    ...meta,
    title: update.title ?? meta.title,
    archived: update.archived ?? meta.archived,
  };
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

const decodeLegacyThreadRow = Schema.decodeUnknownOption(
  Schema.Struct({ thread: Schema.String, session_id: Schema.String }),
);

/** Every thread the legacy table holds, as thread id → session. */
export const legacyThreadSessions = (storage: SqlStorage): Record<string, string> =>
  Object.fromEntries(
    read(storage.sql, "SELECT thread, session_id FROM mackbot_threads").flatMap((row) =>
      Option.match(decodeLegacyThreadRow(row), {
        onNone: () => [],
        onSome: (decoded) => [[decoded.thread, decoded.session_id] as const],
      }),
    ),
  );

/** What only the running harness knows about each conversation. */
export interface ConversationLiveness {
  /** The sessions with a run in flight. */
  readonly busy: ReadonlySet<string>;
  /** Pending approvals, by the session that paused. */
  readonly approvals: ReadonlyMap<string, number>;
}

export interface ThreadListInput {
  /** The document as pi holds it; `undefined` before anything wrote it. */
  readonly doc: ThreadSessions | undefined;
  /** The threads only the legacy table knows. The document wins a conflict. */
  readonly legacy: Readonly<Record<string, string>>;
  /** The root conversation's id. */
  readonly root: string;
  readonly live: ConversationLiveness;
  readonly includeArchived: boolean;
}

const viewOf = (
  thread: string | undefined,
  session: string,
  meta: ConversationMeta,
  live: ConversationLiveness,
): ThreadView => ({
  // The root has no thread id, and a fact never recorded is absent rather
  // than a null the wire does not allow; the JSON answer drops the key.
  thread,
  session,
  title: meta.title ?? undefined,
  createdAt: meta.createdAt ?? undefined,
  lastActivityAt: meta.lastActivityAt ?? undefined,
  archived: meta.archived,
  busy: live.busy.has(session),
  pendingApprovals: live.approvals.get(session) ?? 0,
});

/** The newer of two threads first; a thread that was never active sorts last. */
const byActivity = (left: ThreadView, right: ThreadView): number =>
  (right.lastActivityAt ?? right.createdAt ?? 0) - (left.lastActivityAt ?? left.createdAt ?? 0);

/** One thread's view, or `undefined` for a thread neither record names. */
export const threadViewOf = (
  thread: string,
  input: Omit<ThreadListInput, "includeArchived">,
): ThreadView | undefined => {
  const doc = input.doc ?? emptyThreadSessions();
  const session = Object.hasOwn(doc.threads, thread)
    ? doc.threads[thread]
    : Object.hasOwn(input.legacy, thread)
      ? input.legacy[thread]
      : undefined;
  return session === undefined
    ? undefined
    : viewOf(thread, session, metaOf(doc, session), input.live);
};

/**
 * The conversation list: the root first, because it is where the history
 * from before threads lives and where the cron briefs land, then every
 * thread, the most recently active first. The root cannot be archived.
 */
export const listThreads = (input: ThreadListInput): readonly ThreadView[] => {
  const doc = input.doc ?? emptyThreadSessions();
  const names = new Set([...Object.keys(input.legacy), ...Object.keys(doc.threads)]);
  const threads = [...names]
    .flatMap((thread) => threadViewOf(thread, input) ?? [])
    .filter((view) => input.includeArchived || !view.archived)
    .sort(byActivity);
  const root = viewOf(
    undefined,
    input.root,
    { ...metaOf(doc, input.root), archived: false },
    input.live,
  );
  return [root, ...threads];
};
