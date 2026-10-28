/**
 * transcript — the session's entries, paged backwards by entry id.
 *
 * pi's `EntryRecord.id` is the cursor: it is monotonic per conversation and it
 * is what `?before=` names, so a page is a bounded `conversation.entries()`
 * read rather than a slice of the whole transcript. The read is newest first
 * and asks for one more entry than the page holds, which is how `next` says an
 * older page exists; the page itself is projected oldest first, because that is
 * the order a transcript renders in.
 *
 * Each entry is projected through the run window it falls in, derived from the
 * session's submissions, which is where its `origin` comes from. Its `at` is
 * not: pi commits no timestamp with an entry, and history mackbot did not
 * witness live has none.
 *
 * The paging rule the browser also applies lives in the wire contract.
 */

import type { Cursor, EntryId, EntryQuery, EntryRecord } from "@earendil-works/pi-durable";

import { clampLimit } from "@mackbot/contract";
import { projectEntry, runOfEntry, streamView } from "@mackbot/contract";
import type { PageQuery, RunProjection, StreamStatusView, TranscriptPage } from "@mackbot/contract";

/**
 * One page as `Conversation.entries()` returns it: newest first, with pi's
 * opaque continuation state when older entries remain.
 */
export interface EntryPage {
  readonly items: readonly EntryRecord[];
  readonly next?: Cursor;
}

/** The conversation's newest entry id, or 0 when it has none. */
export const highestEntryId = (records: readonly EntryRecord[]): number => {
  let highest = 0;
  for (const record of records) {
    const id = Number(record.id);
    if (id > highest) highest = id;
  }
  return highest;
};

/** What to read for one transcript page, and how many entries it holds. */
export interface TranscriptRead {
  readonly limit: number;
  readonly query: Omit<EntryQuery, "conversationId">;
}

/**
 * What to read for one transcript page: the bound `before` names, newest first,
 * and exactly the page size. pi's `next` is present only when an older entry
 * exists beyond the page, so the page never needs a speculative extra read.
 * `maxEntryId` is inclusive, so `before` — which is exclusive — becomes the id
 * just below it.
 */
export const transcriptRead = (query: PageQuery): TranscriptRead => {
  const order = { order: "descending" } as const;
  if (query.before === undefined) return { limit: clampLimit(query.limit), query: order };
  // SAFETY: entry ids are positive integers, so the id just below a positive
  // `before` is a valid entry id; `before` is decoded as a positive integer by
  // the query schema.
  const maxEntryId = (query.before - 1) as EntryId;
  return { limit: clampLimit(query.limit), query: { ...order, maxEntryId } };
};

/**
 * One wire page from one pi page. The entries are the page pi returned, oldest
 * first; `nextBefore` is the smallest id returned, so the next request asks for
 * entries strictly older than it and no entry repeats or is skipped.
 */
export const transcriptPage = (
  sessionId: string,
  page: EntryPage,
  runs: readonly RunProjection[],
  query: PageQuery,
  stream: StreamStatusView,
): TranscriptPage => {
  const window = [...page.items]
    .sort((left, right) => Number(left.id) - Number(right.id))
    .slice(-clampLimit(query.limit));
  const entries = window.map((record) => projectEntry(record, runOfEntry(Number(record.id), runs)));
  const oldest = entries[0];
  return {
    session: sessionId,
    entries,
    nextBefore: page.next === undefined || oldest === undefined ? undefined : oldest.id,
    stream,
  };
};

/** A thread with no session yet has nothing witnessed to show. */
export const emptyTranscriptPage = (sessionId: string): TranscriptPage => ({
  session: sessionId,
  entries: [],
  // Generation 0 is the session's name before any segment exists: a client
  // attaches to `/events/:bot` and learns the real stream from a snapshot.
  stream: streamView(sessionId, 0, 0, "completed"),
});
