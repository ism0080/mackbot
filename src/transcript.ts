/**
 * transcript — the session's entries, paged backwards by entry id.
 *
 * pi's `EntryRecord.id` is the cursor: it is monotonic per conversation and it
 * is what `?before=` names, so paging is a filter and a slice, not a second
 * index. Each entry is projected through the run window it falls in, which is
 * where its `at` and its `origin` come from.
 */

import type { EntryRecord } from "@earendil-works/pi-durable";

import type { RunRow } from "./runs.ts";
import { runForEntry, streamViewOf } from "./runs.ts";
import { projectEntry } from "./web-contract.ts";
import type { StreamStatusView, TranscriptPage } from "./web-contract.ts";

/** The page size when the client does not name one. */
export const DEFAULT_LIMIT = 50;

/** The page size ceiling, mirrored by `TranscriptQuerySchema`. */
export const MAX_LIMIT = 200;

export interface PageQuery {
  readonly before?: number;
  readonly limit?: number;
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

/**
 * Clamp rather than reject, because the Durable Object's RPC surface is reachable
 * without the front door's Schema.
 */
export const clampLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isSafeInteger(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(limit, 1), MAX_LIMIT);
};

/** The newest `limit` entries strictly older than `before`, oldest first. */
export interface EntrySlice {
  readonly entries: readonly EntryRecord[];
  readonly nextBefore?: number;
}

export const slicePage = (records: readonly EntryRecord[], query: PageQuery): EntrySlice => {
  const before = query.before ?? Number.POSITIVE_INFINITY;
  const window = [...records]
    .sort((left, right) => Number(left.id) - Number(right.id))
    .filter((record) => Number(record.id) < before);
  const page = window.slice(Math.max(window.length - clampLimit(query.limit), 0));
  const oldest = page[0];
  return {
    entries: page,
    // The oldest id of this page is the exclusive bound of the next one, so a
    // page never repeats or skips an entry.
    nextBefore: window.length > page.length && oldest !== undefined ? Number(oldest.id) : undefined,
  };
};

export const transcriptPage = (
  sessionId: string,
  records: readonly EntryRecord[],
  runs: readonly RunRow[],
  query: PageQuery,
  stream: StreamStatusView,
): TranscriptPage => {
  const { entries, nextBefore } = slicePage(records, query);
  return {
    session: sessionId,
    entries: entries.map((record) => projectEntry(record, runForEntry(Number(record.id), runs))),
    nextBefore,
    stream,
  };
};

/** A thread with no session yet has nothing witnessed to show. */
export const emptyTranscriptPage = (sessionId: string): TranscriptPage => ({
  session: sessionId,
  entries: [],
  stream: streamViewOf(sessionId, undefined, 0),
});
