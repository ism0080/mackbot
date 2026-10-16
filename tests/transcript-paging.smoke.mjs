/**
 * Smoke test for transcript paging (src/transcript.ts).
 *
 * Run with: bun tests/transcript-paging.smoke.mjs
 *
 * The claims this file has to break if they stop holding:
 *   1. `before` pages backwards: walking the pages from the tail visits every
 *      entry exactly once, newest page first.
 *   2. `nextBefore` is present exactly while older entries remain.
 *   3. `limit` is honoured and clamped to [1, 200].
 */
const { DEFAULT_LIMIT, MAX_LIMIT, clampLimit, slicePage } = await import("../src/transcript.ts");

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
};

const entry = (id) => ({ id, conversationId: 7, kind: "pi.user", model: [] });
const ids = (slice) => slice.entries.map((record) => Number(record.id));

const TEN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(entry);

// ---------------------------------------------------------------------------
// Walking backwards with `before` visits every id once.
// ---------------------------------------------------------------------------

{
  const seen = [];
  let before;
  let pages = 0;
  for (;;) {
    const slice = slicePage(TEN, { before, limit: 3 });
    seen.unshift(...ids(slice));
    pages += 1;
    if (slice.nextBefore === undefined) break;
    before = slice.nextBefore;
    if (pages > 10) break;
  }
  check("paging backwards terminates", pages === 4, `${pages} pages`);
  check("paging backwards visits every entry once", JSON.stringify(seen) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), JSON.stringify(seen));
}

{
  const first = slicePage(TEN, { limit: 3 });
  check("the first page is the newest entries, oldest first", JSON.stringify(ids(first)) === "[8,9,10]", JSON.stringify(ids(first)));
  check("the first page offers a cursor", first.nextBefore === 8, `${first.nextBefore}`);

  const second = slicePage(TEN, { before: first.nextBefore, limit: 3 });
  check("before is exclusive of the cursor", !ids(second).includes(8), JSON.stringify(ids(second)));
  check("the second page is the previous three", JSON.stringify(ids(second)) === "[5,6,7]", JSON.stringify(ids(second)));
}

{
  const last = slicePage(TEN, { before: 2, limit: 3 });
  check("the final partial page holds the head", JSON.stringify(ids(last)) === "[1]", JSON.stringify(ids(last)));
  check("the final page offers no cursor", last.nextBefore === undefined);

  const beyond = slicePage(TEN, { before: 999, limit: 3 });
  check("an out-of-range cursor still returns the tail", JSON.stringify(ids(beyond)) === "[8,9,10]", JSON.stringify(ids(beyond)));
}

// ---------------------------------------------------------------------------
// The limit is honoured and clamped.
// ---------------------------------------------------------------------------

{
  const many = Array.from({ length: 250 }, (_, index) => entry(index + 1));
  check("the default limit applies", clampLimit(undefined) === DEFAULT_LIMIT, `${clampLimit(undefined)}`);
  check("zero clamps up to one", clampLimit(0) === 1, `${clampLimit(0)}`);
  check("negative clamps up to one", clampLimit(-4) === 1, `${clampLimit(-4)}`);
  check("over the ceiling clamps down", clampLimit(10_000) === MAX_LIMIT, `${clampLimit(10_000)}`);
  check("a non-integer falls back to the default", clampLimit(2.5) === DEFAULT_LIMIT, `${clampLimit(2.5)}`);

  const page = slicePage(many, { limit: 10_000 });
  check("the clamped limit bounds the page", page.entries.length === MAX_LIMIT, `${page.entries.length}`);
  check("the clamped page still has an older page", page.nextBefore === 51, `${page.nextBefore}`);

  const tiny = slicePage(many, { limit: 0 });
  check("a zero limit returns one entry", tiny.entries.length === 1, `${tiny.entries.length}`);
  check("a zero limit returns the newest", Number(tiny.entries[0].id) === 250, `${tiny.entries[0].id}`);

  const wanted = slicePage(TEN, { limit: 4 });
  check("the requested limit is respected", wanted.entries.length === 4, `${wanted.entries.length}`);
}

if (failures.length > 0) {
  console.error("transcript paging smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("transcript paging smoke passed");
process.exit(0);
