import { originOf } from "@mackbot/contract";
import { describe, expect, test } from "vitest";

import {
  abortOperationId,
  approvalOperationId,
  cronOperationId,
  delegateCallerOperationId,
  delegateOperationId,
  delegateReportRequestId,
  delegateTaskOperationId,
  httpOperationId,
} from "../src/operation.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

describe("httpOperationId", () => {
  test("generates an http:-prefixed id when omitted", () => {
    const id = httpOperationId(undefined);
    expect(id.startsWith("http:")).toBe(true);
    expect(UUID_PATTERN.test(id.slice("http:".length))).toBe(true);
  });

  test("prefixes a caller-supplied bare id exactly once", () => {
    expect(httpOperationId("abc-123")).toBe("http:abc-123");
    expect(httpOperationId("http-ish")).toBe("http:http-ish");
  });

  test("leaves an already-prefixed id unchanged", () => {
    expect(httpOperationId("http:abc-123")).toBe("http:abc-123");
  });

  test("is stable for the same supplied id", () => {
    expect(httpOperationId("abc-123")).toBe(httpOperationId("abc-123"));
  });

  test("generates different ids when none is supplied", () => {
    expect(httpOperationId(undefined)).not.toBe(httpOperationId(undefined));
  });
});

describe("cronOperationId", () => {
  const scheduled = 1_760_000_000_000;

  test("starts with cron: and has the documented shape", () => {
    expect(cronOperationId("hermes", scheduled)).toBe(`cron:hermes:${scheduled}`);
  });

  test("is stable for the same bot and scheduled time", () => {
    expect(cronOperationId("hermes", scheduled)).toBe(cronOperationId("hermes", scheduled));
  });

  test("differs for a different bot", () => {
    expect(cronOperationId("hermes", scheduled)).not.toBe(cronOperationId("scribe", scheduled));
  });

  test("differs for a different scheduled time", () => {
    expect(cronOperationId("hermes", scheduled)).not.toBe(cronOperationId("hermes", scheduled + 1));
  });
});

describe("approvalOperationId and abortOperationId", () => {
  test("approval ids are http-prefixed and derived from the approval", () => {
    expect(approvalOperationId("ap-42")).toBe("http:approval:ap-42");
  });

  test("a replayed approval decision derives the same operation id", () => {
    expect(approvalOperationId("ap-42")).toBe(approvalOperationId("ap-42"));
  });

  test("abort ids have the documented shape", () => {
    expect(abortOperationId("session-7")).toBe("abort:session-7");
  });
});

describe("delegation ids", () => {
  test("a task id is named after the source bot and the task", () => {
    expect(delegateTaskOperationId("hermes", "task-1")).toBe("delegate:hermes:task:task-1");
    expect(delegateTaskOperationId("hermes", "task-1")).toBe(
      delegateTaskOperationId("hermes", "task-1"),
    );
  });

  test("a caller-supplied id is namespaced under a caller: segment", () => {
    expect(delegateCallerOperationId("hermes", "abc")).toBe("delegate:hermes:caller:abc");
  });

  test("a caller-supplied id cannot masquerade as another origin's work", () => {
    const forged = delegateCallerOperationId("hermes", "cron:hermes:1760000000000");
    expect(forged).toBe("delegate:hermes:caller:cron:hermes:1760000000000");
    expect(originOf(forged)).toBe("delegate");
    expect(forged).not.toBe("cron:hermes:1760000000000");
  });

  test("the report request id derives from the source bot and task", () => {
    expect(delegateReportRequestId("hermes", "task-1")).toBe("delegate-report:hermes:task:task-1");
  });

  test("delegateOperationId generates a delegate-prefixed id when omitted", () => {
    const id = delegateOperationId("hermes", undefined);
    expect(id.startsWith("delegate:hermes:")).toBe(true);
    expect(id).not.toBe(delegateOperationId("hermes", undefined));
  });

  test("delegateOperationId namespaces a supplied bare id", () => {
    expect(delegateOperationId("hermes", "abc")).toBe("delegate:hermes:abc");
    expect(originOf(delegateOperationId("hermes", "abc"))).toBe("delegate");
  });

  test("delegateOperationId does not prefix an id already carrying delegate:", () => {
    expect(delegateOperationId("hermes", "delegate:hermes:task:task-1")).toBe(
      "delegate:hermes:task:task-1",
    );
  });
});

describe("originOf", () => {
  test("reads each prefix back", () => {
    expect(originOf("http:abc")).toBe("http");
    expect(originOf("cron:hermes:1760000000000")).toBe("cron");
    expect(originOf("delegate:hermes:task:task-1")).toBe("delegate");
  });

  test("defaults an unprefixed id to http", () => {
    expect(originOf("abc-123")).toBe("http");
    expect(originOf("")).toBe("http");
  });
});
