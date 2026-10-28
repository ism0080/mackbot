/**
 * Paging is the transcript's real boundary: the Worker slices each page and the
 * browser walks the same pages backwards. These tests pin the contract a client
 * depends on — exclusive `before`, no repeated or skipped ids — rather than the
 * implementation's shape.
 */

import { describe, expect, test } from "vitest";

import { DEFAULT_LIMIT, MAX_LIMIT, clampLimit, runOfEntry, slicePage } from "../src/index.ts";
import type { PageQuery, RunProjection } from "../src/index.ts";

interface Row {
  readonly id: number;
}

/** Fresh rows on every call, so no test can mutate another's fixture. */
const rows = (...ids: readonly number[]): readonly Row[] => ids.map((id) => ({ id }));

const idsOf = (page: { readonly entries: readonly Row[] }): readonly number[] =>
  page.entries.map((entry) => entry.id);

/**
 * Walk from newest to oldest by following `nextBefore`, returning every id in
 * the order the pages delivered them.
 */
const walk = (entries: readonly Row[], query: PageQuery) => {
  const seen: number[] = [];
  const pages: number[][] = [];
  let before = query.before;

  for (let step = 0; step < 100; step += 1) {
    const page = slicePage(entries, { limit: query.limit, before });
    const pageIds = [...idsOf(page)];
    pages.push(pageIds);
    seen.push(...pageIds);

    if (page.nextBefore === undefined) {
      return { seen, pages };
    }
    // The bound of the next page is the oldest id this page delivered.
    expect(page.nextBefore).toBe(pageIds[0]);
    before = page.nextBefore;
  }

  throw new Error("paging did not terminate");
};

describe("slicePage", () => {
  test("returns the newest limit entries, oldest first", () => {
    const page = slicePage(rows(1, 2, 3, 4, 5, 6, 7, 8, 9, 10), { limit: 3 });

    expect(idsOf(page)).toEqual([8, 9, 10]);
    expect(page.nextBefore).toBe(8);
  });

  test("returns every entry when the list fits and offers no next bound", () => {
    const page = slicePage(rows(1, 2, 3), { limit: 10 });

    expect(idsOf(page)).toEqual([1, 2, 3]);
    expect(page.nextBefore).toBeUndefined();
  });

  test("returns an empty page for an empty transcript", () => {
    const page = slicePage<Row>([], { limit: 5 });

    expect(page.entries).toEqual([]);
    expect(page.nextBefore).toBeUndefined();
  });

  test("treats before as exclusive", () => {
    const entries = rows(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);

    const page = slicePage(entries, { limit: 3, before: 5 });
    expect(idsOf(page)).toEqual([2, 3, 4]);
    expect(idsOf(page)).not.toContain(5);
    expect(page.nextBefore).toBe(2);

    const exact = slicePage(entries, { limit: 10, before: 5 });
    expect(idsOf(exact)).toEqual([1, 2, 3, 4]);
    expect(exact.nextBefore).toBeUndefined();
  });

  test("a before cursor past the newest entry delivers the newest page", () => {
    const page = slicePage(rows(1, 2, 3), { limit: 2, before: 99 });

    expect(idsOf(page)).toEqual([2, 3]);
    expect(page.nextBefore).toBe(2);
  });

  test("sorts unsorted input by numeric id, not lexically", () => {
    // Lexical order would put 10 and 33 before 2; numeric order does not.
    const page = slicePage(rows(10, 2, 33, 4), { limit: 2 });

    expect(idsOf(page)).toEqual([10, 33]);
  });

  test("walks the whole transcript without repeating or skipping an id", () => {
    const entries = rows(3, 1, 7, 2, 9, 4, 8, 6, 5, 10);
    const { seen, pages } = walk(entries, { limit: 3 });

    expect(pages).toEqual([[8, 9, 10], [5, 6, 7], [2, 3, 4], [1]]);
    expect([...seen].sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("walking with gaps still visits every id exactly once", () => {
    const entries = rows(1, 9, 4, 5);
    const { seen, pages } = walk(entries, { limit: 2 });

    expect(pages).toEqual([
      [5, 9],
      [1, 4],
    ]);
    expect([...seen].sort((left, right) => left - right)).toEqual([1, 4, 5, 9]);
  });

  test("a page large enough for the list returns it in one step", () => {
    const entries = rows(5, 1, 3, 2, 4);
    const { seen, pages } = walk(entries, { limit: 200 });

    expect(pages).toEqual([[1, 2, 3, 4, 5]]);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  test("starts from the before cursor, not from the head of the list", () => {
    const entries = rows(1, 2, 3, 4, 5, 6, 7, 8);
    const { seen } = walk(entries, { limit: 3, before: 6 });

    expect(seen).toEqual([3, 4, 5, 1, 2]);
    expect(seen).not.toContain(6);
    expect(seen).not.toContain(7);
  });

  test("clamps a zero limit up to one entry rather than returning nothing", () => {
    const page = slicePage(rows(1, 2, 3), { limit: 0 });

    expect(idsOf(page)).toEqual([3]);
    expect(page.nextBefore).toBe(3);
  });
});

describe("clampLimit", () => {
  test.each([
    [undefined, DEFAULT_LIMIT],
    [Number.NaN, DEFAULT_LIMIT],
    [50.5, DEFAULT_LIMIT],
    [Number.POSITIVE_INFINITY, DEFAULT_LIMIT],
    [Number.NEGATIVE_INFINITY, DEFAULT_LIMIT],
    [0, 1],
    [-5, 1],
    [1, 1],
    [50, 50],
    [200, MAX_LIMIT],
    [201, MAX_LIMIT],
    [1_000_000, MAX_LIMIT],
  ])("clamps %j to %j", (limit, expected) => {
    expect(clampLimit(limit)).toBe(expected);
  });

  test("keeps the default inside the ceiling", () => {
    expect(DEFAULT_LIMIT).toBeLessThanOrEqual(MAX_LIMIT);
  });
});

describe("runOfEntry", () => {
  const early: RunProjection = { operationId: "http:early", startEntry: 10, answer: 20 };
  const late: RunProjection = { operationId: "http:late", startEntry: 15, answer: 25 };
  const open: RunProjection = { operationId: "cron:nightly", startEntry: 30 };

  test("owns the entries from its input through its answer", () => {
    expect(runOfEntry(10, [early])).toBe(early);
    expect(runOfEntry(15, [early])).toBe(early);
    expect(runOfEntry(20, [early])).toBe(early);
  });

  test("owns nothing outside its window", () => {
    expect(runOfEntry(9, [early])).toBeUndefined();
    expect(runOfEntry(21, [early])).toBeUndefined();
    expect(runOfEntry(0, [early])).toBeUndefined();
  });

  test("chooses the newest overlapping run regardless of array order", () => {
    expect(runOfEntry(17, [early, late])).toBe(late);
    expect(runOfEntry(17, [late, early])).toBe(late);
    expect(runOfEntry(22, [early, late])).toBe(late);
  });

  test("prefers a newer run nested inside an older one", () => {
    const outer: RunProjection = { operationId: "http:outer", startEntry: 10, answer: 100 };
    const inner: RunProjection = { operationId: "delegate:inner", startEntry: 40, answer: 50 };

    expect(runOfEntry(45, [outer, inner])).toBe(inner);
    expect(runOfEntry(60, [outer, inner])).toBe(outer);
    expect(runOfEntry(100, [outer, inner])).toBe(outer);
    expect(runOfEntry(101, [outer, inner])).toBeUndefined();
  });

  test("an open-ended run owns every later entry", () => {
    expect(runOfEntry(30, [open])).toBe(open);
    expect(runOfEntry(31, [open])).toBe(open);
    expect(runOfEntry(10_000, [open])).toBe(open);
    expect(runOfEntry(29, [open])).toBeUndefined();
  });

  test("a run whose answer is its own input owns exactly one entry", () => {
    const single: RunProjection = { operationId: "http:single", startEntry: 7, answer: 7 };

    expect(runOfEntry(7, [single])).toBe(single);
    expect(runOfEntry(6, [single])).toBeUndefined();
    expect(runOfEntry(8, [single])).toBeUndefined();
  });

  test("returns undefined when there are no runs", () => {
    expect(runOfEntry(1, [])).toBeUndefined();
  });
});
