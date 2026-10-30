/**
 * An operation id names the work it started, and its prefix says where that
 * work came from. Both sides read the origin with the same rule.
 */

import { describe, expect, test } from "vitest";

import { OPERATION_ORIGINS, OPERATION_PREFIXES, originOf } from "../src/index.ts";

describe("originOf", () => {
  test.each([
    ["cron:daily-digest", "cron"],
    ["delegate:task-7", "delegate"],
    ["http:req-88", "http"],
    ["req-with-no-prefix", "http"],
    ["", "http"],
    ["HTTP:REQ-1", "http"],
    ["notcron:req-1", "http"],
    ["cronreq-1", "http"],
  ] as const)("reads %j as %s", (operationId, expected) => {
    expect(originOf(operationId)).toBe(expected);
  });

  test("every declared prefix reads back as its own origin", () => {
    // The prefix table is the source of truth for both sides, so a new origin
    // cannot be added to one without the reader knowing it.
    for (const origin of Object.values(OPERATION_ORIGINS)) {
      expect(originOf(`${OPERATION_PREFIXES[origin]}req-1`)).toBe(origin);
    }
  });
});
