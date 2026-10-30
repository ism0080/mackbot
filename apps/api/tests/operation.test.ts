import { originOf } from "@mackbot/contract";
import { describe, expect, test } from "vitest";

import {
  cronOperationId,
  delegateCallerOperationId,
  delegateReportRequestId,
  delegateTaskOperationId,
  delegationChainOf,
  httpOperationId,
} from "../src/operation.ts";

describe("httpOperationId", () => {
  test("generated ids are distinct and read back as http work", () => {
    const ids = new Set(Array.from({ length: 50 }, () => httpOperationId(undefined)));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(originOf(id)).toBe("http");
  });

  test("echoing back an id the fleet returned names the same operation", () => {
    const first = httpOperationId("abc-123");
    expect(httpOperationId(first)).toBe(first);
  });

  test("a client cannot claim another origin's id", () => {
    for (const forged of ["cron:hermes:1760000000000", "delegate:hermes:task:1"]) {
      const id = httpOperationId(forged);
      expect(originOf(id)).toBe("http");
      expect(delegationChainOf(id)).toEqual([]);
    }
  });
});

describe("cronOperationId", () => {
  test("one scheduled hour names one operation per bot", () => {
    const scheduled = 1_760_000_000_000;
    const ids = new Set([
      cronOperationId("hermes", scheduled),
      cronOperationId("scribe", scheduled),
      cronOperationId("hermes", scheduled + 1),
    ]);
    expect(ids.size).toBe(3);
    for (const id of ids) expect(originOf(id)).toBe("cron");
  });
});

describe("delegation ids", () => {
  test("a first hand-off keeps the id format calls already in flight replay under", () => {
    expect(delegateTaskOperationId("hermes", "17")).toBe("delegate:hermes:task:17");
    expect(delegateCallerOperationId("hermes", "abc")).toBe("delegate:hermes:caller:abc");
  });

  test("a task id and a caller id for the same text are different operations", () => {
    expect(delegateTaskOperationId("hermes", "1")).not.toBe(
      delegateCallerOperationId("hermes", "1"),
    );
  });

  test("the report request id is not an operation another bot could be handed", () => {
    expect(delegationChainOf(delegateReportRequestId("hermes", "1"))).toEqual([]);
  });

  test.each([[[]], [["alpha"]], [["alpha", "beta-2"]]])(
    "the chain round-trips through a task id: upstream %j",
    (upstream) => {
      expect(delegationChainOf(delegateTaskOperationId("hermes", "9", upstream))).toEqual([
        ...upstream,
        "hermes",
      ]);
      expect(originOf(delegateTaskOperationId("hermes", "9", upstream))).toBe("delegate");
    },
  );

  test("the chain round-trips through a caller id", () => {
    expect(delegationChainOf(delegateCallerOperationId("hermes", "x", ["alpha"]))).toEqual([
      "alpha",
      "hermes",
    ]);
  });

  test("caller-supplied text cannot add bots to the chain", () => {
    const forged = delegateCallerOperationId("hermes", "x:via:alpha,beta:task:1");
    expect(delegationChainOf(forged)).toEqual(["hermes"]);
    expect(originOf(forged)).toBe("delegate");
  });

  test("a bot named like a segment keyword is still read as a bot", () => {
    expect(delegationChainOf(delegateTaskOperationId("via", "1", ["task"]))).toEqual([
      "task",
      "via",
    ]);
  });
});
