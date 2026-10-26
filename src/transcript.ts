/**
 * transcript — the session's entries, paged backwards by entry id.
 *
 * pi's `EntryRecord.id` is the cursor: it is monotonic per conversation and it
 * is what `?before=` names, so paging is a filter and a slice, not a second
 * index. Each entry is projected through the run window it falls in, which is
 * where its `at` and its `origin` come from.
 *
 * The paging rule itself lives in the wire contract, because the browser
 * pages against the same rule.
 */

import type { EntryRecord } from "@earendil-works/pi-durable";

import type { RunRow } from "./runs.ts";
import { runForEntry, streamViewOf } from "./runs.ts";
import { projectEntry, slicePage } from "@mackbot/contract";
import type { PageQuery, StreamStatusView, TranscriptPage } from "@mackbot/contract";

/** The conversation's newest entry id, or 0 when it has none. */
export const highestEntryId = (records: readonly EntryRecord[]): number => {
  let highest = 0;
  for (const record of records) {
    const id = Number(record.id);
    if (id > highest) highest = id;
  }
  return highest;
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
