/**
 * Smoke test for transcript paging (src/transcript.ts over pi's entry scan).
 *
 * Run with: bun tests/transcript-paging.smoke.mjs
 *
 * The claims this file has to break if they stop holding:
 *   1. A page is a bounded `conversation.entries()` read, not a slice of the
 *      whole transcript: the request is newest first, asks for one entry more
 *      than the page shows, and turns the exclusive `before` into an inclusive
 *      `maxEntryId` just below it.
 *   2. `nextBefore` is the smallest returned id, and only when the read says an
 *      older page exists — so walking the pages from the tail visits every
 *      entry exactly once, newest page first.
 *   3. `limit` is honoured and clamped to [1, 200].
 *   4. An entry's `origin` is joined from the run projection it falls in.
 */
const { DEFAULT_LIMIT, MAX_LIMIT, clampLimit } = await import("@mackbot/contract");
const { transcriptRead, transcriptPage } = await import("../src/transcript.ts");

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
};

const entry = (id) => ({ id, conversationId: 7, kind: "pi.user", model: [] });
const ids = (page) => page.entries.map((view) => view.id);

const STREAM = { stream: "feed:1:1", generation: 1, cursor: 0, state: "completed" };

const TEN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(entry);

/**
 * pi's `conversation.entries()` as the module asks for it: bounded by the
 * query's ids, in the query's order, at most `limit` items, with `next` set
 * when more remain.
 */
const scan = (records, query, limit) => {
  const order = query.order ?? "descending";
  const bounded = records
    .filter((record) => query.maxEntryId === undefined || record.id <= query.maxEntryId)
    .filter((record) => query.minEntryId === undefined || record.id >= query.minEntryId)
    .sort((left, right) => (order === "ascending" ? left.id - right.id : right.id - left.id));
  const items = bounded.slice(0, limit);
  return { items, next: bounded.length > limit ? { at: items.at(-1).id } : undefined };
};

/** One wire page, read exactly the way the Worker reads it. */
const readPage = (records, query, runs = []) => {
  const read = transcriptRead(query);
  return transcriptPage("1", scan(records, read.query, read.limit), runs, query, STREAM);
};

// ---------------------------------------------------------------------------
// The read is bounded, newest first, and one past the page size.
// ---------------------------------------------------------------------------

{
  const all = transcriptRead({});
  check("the read is newest first", all.query.order === "descending", all.query.order);
  check("an unbounded read asks for the default page", all.limit === DEFAULT_LIMIT, `${all.limit}`);
  check("an unbounded read has no upper id", all.query.maxEntryId === undefined);

  const bounded = transcriptRead({ before: 8 });
  check(
    "before becomes the inclusive id just below it",
    bounded.query.maxEntryId === 7,
    `${bounded.query.maxEntryId}`,
  );
  check("before is not carried into the read", bounded.query.minEntryId === undefined);
  check("limit 0 clamps up to one", transcriptRead({ limit: 0 }).limit === 1);
  check(
    "an over-ceiling limit clamps down",
    transcriptRead({ limit: 10_000 }).limit === MAX_LIMIT,
    `${transcriptRead({ limit: 10_000 }).limit}`,
  );
  check(
    "a non-integer limit falls back to the default",
    transcriptRead({ limit: 2.5 }).limit === DEFAULT_LIMIT,
  );
}

// ---------------------------------------------------------------------------
// Walking backwards with `nextBefore` visits every id once.
// ---------------------------------------------------------------------------

{
  const seen = [];
  let before;
  let pages = 0;
  for (;;) {
    const page = readPage(TEN, { before, limit: 3 });
    seen.unshift(...ids(page));
    pages += 1;
    if (page.nextBefore === undefined) break;
    before = page.nextBefore;
    if (pages > 10) break;
  }
  check("paging backwards terminates", pages === 4, `${pages} pages`);
  check(
    "paging backwards visits every entry once",
    JSON.stringify(seen) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    JSON.stringify(seen),
  );
}

{
  const first = readPage(TEN, { limit: 3 });
  check(
    "the first page is the newest entries, oldest first",
    JSON.stringify(ids(first)) === "[8,9,10]",
    JSON.stringify(ids(first)),
  );
  check("the first page offers a cursor", first.nextBefore === 8, `${first.nextBefore}`);
  check("the page names its session", first.session === "1");
  check("the page carries the stream to attach to", first.stream.stream === STREAM.stream);

  const second = readPage(TEN, { before: first.nextBefore, limit: 3 });
  check("before is exclusive of the cursor", !ids(second).includes(8), JSON.stringify(ids(second)));
  check(
    "the second page is the previous three",
    JSON.stringify(ids(second)) === "[5,6,7]",
    JSON.stringify(ids(second)),
  );
}

{
  const last = readPage(TEN, { before: 2, limit: 3 });
  check("the final partial page holds the head", JSON.stringify(ids(last)) === "[1]");
  check("the final page offers no cursor", last.nextBefore === undefined);

  const beyond = readPage(TEN, { before: 999, limit: 3 });
  check(
    "an out-of-range cursor still returns the tail",
    JSON.stringify(ids(beyond)) === "[8,9,10]",
    JSON.stringify(ids(beyond)),
  );
}

{
  const empty = readPage([], { limit: 3 });
  check("an empty transcript reads as an empty page", empty.entries.length === 0);
  check("an empty page offers no cursor", empty.nextBefore === undefined);
  check("an empty page still names its stream", empty.stream.stream === STREAM.stream);
}

// ---------------------------------------------------------------------------
// The page size is the clamp, and the read's extra entry is not shown.
// ---------------------------------------------------------------------------

{
  const many = Array.from({ length: 250 }, (_, index) => entry(index + 1));
  const page = readPage(many, { limit: 10_000 });
  check(
    "the clamped limit bounds the page",
    page.entries.length === MAX_LIMIT,
    `${page.entries.length}`,
  );
  check("the clamped page still has an older page", page.nextBefore === 51, `${page.nextBefore}`);
  check("the clamped page ends at the newest entry", page.entries.at(-1)?.id === 250);

  const tiny = readPage(many, { limit: 0 });
  check("a zero limit returns one entry", tiny.entries.length === 1, `${tiny.entries.length}`);
  check("a zero limit returns the newest", tiny.entries[0]?.id === 250, `${tiny.entries[0]?.id}`);
  check("a zero limit still offers a cursor", tiny.nextBefore === 250, `${tiny.nextBefore}`);

  const wanted = readPage(TEN, { limit: 4 });
  check(
    "the requested limit is respected",
    wanted.entries.length === 4,
    `${wanted.entries.length}`,
  );

  check("the clamp helper agrees", clampLimit(10_000) === MAX_LIMIT && clampLimit(0) === 1);
}

// ---------------------------------------------------------------------------
// An entry's origin comes from the run projection that contains it.
// ---------------------------------------------------------------------------

{
  const runs = [{ operationId: "cron:hermes:1", startEntry: 5, answer: 7 }];
  const page = readPage(TEN, { before: 9, limit: 4 }, runs);
  const originOf = (id) => page.entries.find((view) => view.id === id)?.origin;
  check(
    "the page keeps its order through the run join",
    JSON.stringify(ids(page)) === "[5,6,7,8]",
    JSON.stringify(ids(page)),
  );
  check("an entry inside the run carries its origin", originOf(6) === "cron", `${originOf(6)}`);
  check("an entry before the run has no origin", originOf(4) === undefined, `${originOf(4)}`);
  check("a paged entry is undated", page.entries[0]?.at === undefined, `${page.entries[0]?.at}`);
}

if (failures.length > 0) {
  console.error("transcript paging smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("transcript paging smoke passed");
process.exit(0);
