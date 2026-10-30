import type { ConversationId, ReportInfo, TaskId } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FAILURE_RETENTION_MS, classifyFailure, createFailureStore } from "../src/failures.ts";
import { memoryStorage } from "./support/sqlite.ts";

// SAFETY: pi's ids are branded numbers; the brand is all these casts add.
const task = { id: 7 as TaskId, kind: "pi.tool", conversationId: 1 as ConversationId };

const SESSION_FAILED: ReportInfo = { type: "session_failed" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("classifyFailure", () => {
  test("keeps the harness's kind and the task it names", () => {
    const failure = classifyFailure(new RangeError("too far"), {
      type: "task_faulted",
      task,
      extension: "bot-delegation",
      reason: "threw",
    });
    expect(failure).toEqual({
      kind: "task_faulted",
      name: "RangeError",
      detail: "too far",
      taskId: "7",
      taskKind: "pi.tool",
      extension: "bot-delegation",
    });
  });

  test("names the host callback that threw", () => {
    const failure = classifyFailure(new Error("no"), { type: "host_error", callback: "models" });
    expect(failure.callback).toBe("models");
    expect(failure.taskId).toBeUndefined();
  });

  test("caps a long detail at 500 characters, marker included", () => {
    const failure = classifyFailure(new Error("x".repeat(2_000)), SESSION_FAILED);
    expect(failure.detail).toHaveLength(500);
    expect(failure.detail.endsWith("...")).toBe(true);
  });

  test("formats a thrown value that cannot be stringified instead of throwing", () => {
    const failure = classifyFailure(Object.create(null), SESSION_FAILED);
    expect(failure.name).toBe("Error");
    expect(failure.detail).toBe("[object Object]");
  });
});

describe("createFailureStore", () => {
  test("lists failures newest first, breaking a same-millisecond tie by insertion", () => {
    const store = createFailureStore(memoryStorage());
    vi.setSystemTime(1_000);
    store.record(new Error("first"), SESSION_FAILED);
    store.record(new Error("second"), SESSION_FAILED);
    vi.setSystemTime(2_000);
    store.record(new Error("third"), SESSION_FAILED);

    expect(store.recent().map((failure) => failure.detail)).toEqual(["third", "second", "first"]);
    expect(store.recent(1).map((failure) => failure.detail)).toEqual(["third"]);
  });

  test("a negative limit lists nothing rather than everything", () => {
    const store = createFailureStore(memoryStorage());
    store.record(new Error("one"), SESSION_FAILED);
    expect(store.recent(-1)).toEqual([]);
  });

  test("record swallows a storage failure, because it runs in the harness's failure path", () => {
    const store = createFailureStore({
      sql: {
        exec: () => {
          throw new Error("storage is gone");
        },
      },
    });
    expect(() => store.record(new Error("boom"), SESSION_FAILED)).not.toThrow();
  });

  test("adds the task columns to a table an earlier revision created", () => {
    const storage = memoryStorage();
    storage.db.exec(
      "CREATE TABLE mackbot_failures (at INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, detail TEXT NOT NULL)",
    );
    const store = createFailureStore(storage);
    store.record(new Error("parked"), { type: "task_parked", task, extension: "executor" });
    expect(store.recent()[0]).toMatchObject({
      kind: "task_parked",
      taskId: "7",
      extension: "executor",
    });
  });

  test("prune drops failures past the retention window and keeps the rest", () => {
    const store = createFailureStore(memoryStorage());
    const now = 100 * FAILURE_RETENTION_MS;
    vi.setSystemTime(now - FAILURE_RETENTION_MS - 1);
    store.record(new Error("stale"), SESSION_FAILED);
    vi.setSystemTime(now - FAILURE_RETENTION_MS + 1);
    store.record(new Error("recent"), SESSION_FAILED);
    vi.setSystemTime(now);

    expect(store.prune()).toBe(1);
    expect(store.recent().map((failure) => failure.detail)).toEqual(["recent"]);
    expect(store.prune()).toBe(0);
  });

  test("prune takes an explicit cutoff", () => {
    const store = createFailureStore(memoryStorage());
    vi.setSystemTime(10);
    store.record(new Error("old"), SESSION_FAILED);
    vi.setSystemTime(20);
    store.record(new Error("new"), SESSION_FAILED);

    expect(store.prune(20)).toBe(1);
    expect(store.recent().map((failure) => failure.detail)).toEqual(["new"]);
  });
});
