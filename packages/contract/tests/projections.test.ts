/**
 * Projections turn pi's durable documents into the views the browser renders.
 * Each test takes a realistic document and asserts the renderable answer — the
 * join rules, the ids, and the omissions a client would otherwise have to make
 * for itself.
 */

import { describe, expect, test } from "vitest";

import {
  OPERATION_ORIGINS,
  OPERATION_PREFIXES,
  inboxView,
  liveView,
  originOf,
  projectEntry,
  runOfEntry,
  streamIdFor,
  streamView,
  usageView,
} from "../src/index.ts";
import type { EntryView, RunProjection } from "../src/index.ts";
import {
  TIMESTAMP,
  assistantMessage,
  entryRecord,
  systemMessage,
  textBlock,
  thinkingBlock,
  toolResultMessage,
  userMessage,
} from "./support.ts";

const runFor = (operationId: string, startEntry = 1, answer?: number): RunProjection => {
  const run: RunProjection = { operationId, startEntry };
  return answer === undefined ? run : { ...run, answer };
};

describe("projectEntry", () => {
  test("joins several model messages with a newline", () => {
    const view = projectEntry(
      entryRecord({
        id: 42,
        kind: "turn",
        model: [
          userMessage("Summarise the build."),
          assistantMessage([thinkingBlock("Think first."), textBlock("The build is green.")]),
        ],
      }),
    );

    expect(view.text).toBe("Summarise the build.\nThe build is green.");
    expect(view.id).toBe(42);
    expect(view.kind).toBe("turn");
  });

  test.each([
    ["user", () => [userMessage("hello")], "user"],
    ["assistant", () => [assistantMessage([textBlock("hello")])], "assistant"],
    [
      "toolResult",
      () => [toolResultMessage({ toolName: "read_file", content: [textBlock("ok")] })],
      "tool",
    ],
    ["system", () => [systemMessage("You are Mack.")], "system"],
    ["a record with no model messages", () => undefined, "system"],
  ] as const)("maps a %s entry", (_label, model, expectedRole) => {
    const view = projectEntry(entryRecord({ id: 1, kind: "entry", model: model() }));

    expect(view.role).toBe(expectedRole);
  });

  test("reads text out of string and block content alike", () => {
    const stringSystem = projectEntry(
      entryRecord({ id: 1, kind: "system", model: [systemMessage("Be brief.")] }),
    );
    const blockSystem = projectEntry(
      entryRecord({
        id: 2,
        kind: "system",
        model: [systemMessage([textBlock("Be "), textBlock("brief.")])],
      }),
    );
    const userWithImage = projectEntry(
      entryRecord({
        id: 3,
        kind: "user",
        model: [
          userMessage([
            textBlock("What is in this image?"),
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          ]),
        ],
      }),
    );

    expect(stringSystem.text).toBe("Be brief.");
    expect(blockSystem.text).toBe("Be brief.");
    expect(userWithImage.text).toBe("What is in this image?");
  });

  test("keeps only the text blocks of an assistant response", () => {
    const view = projectEntry(
      entryRecord({
        id: 5,
        kind: "assistant",
        model: [
          assistantMessage([
            thinkingBlock("This is private reasoning."),
            textBlock("The answer is 4."),
          ]),
        ],
      }),
    );

    expect(view.text).toBe("The answer is 4.");
    expect(view.text).not.toContain("private");
  });

  test("exposes toolName and toolFailed only for a tool result", () => {
    const successful = projectEntry(
      entryRecord({
        id: 6,
        kind: "toolResult",
        model: [toolResultMessage({ toolName: "read_file", content: [textBlock("ok")] })],
      }),
    );
    const failed = projectEntry(
      entryRecord({
        id: 7,
        kind: "toolResult",
        model: [
          toolResultMessage({
            toolName: "run_tests",
            content: [textBlock("2 failing")],
            isError: true,
          }),
        ],
      }),
    );
    const user = projectEntry(entryRecord({ id: 8, kind: "user", model: [userMessage("hello")] }));

    expect(successful.toolName).toBe("read_file");
    expect(successful.toolFailed).toBe(false);
    expect(failed.toolName).toBe("run_tests");
    expect(failed.toolFailed).toBe(true);

    expect("toolName" in user).toBe(false);
    expect("toolFailed" in user).toBe(false);
    expect(user.toolName).toBeUndefined();
  });

  test.each([
    ["http", "http:req-88", "http"],
    ["cron", "cron:nightly", "cron"],
    ["delegate", "delegate:task-7", "delegate"],
  ] as const)("maps a %s operation to its origin", (_label, operationId, expected) => {
    const view = projectEntry(
      entryRecord({ id: 9, kind: "user", model: [userMessage("go")] }),
      runFor(operationId, 9),
    );

    expect(view.origin).toBe(expected);
  });

  test("drops the origin when the run's operation id is empty", () => {
    const view = projectEntry(
      entryRecord({ id: 10, kind: "user", model: [userMessage("go")] }),
      runFor("", 10),
    );

    expect(view.origin).toBeUndefined();
  });

  test("drops the origin when no run answers the entry", () => {
    const view = projectEntry(entryRecord({ id: 11, kind: "user", model: [userMessage("go")] }));

    expect(view.origin).toBeUndefined();
  });

  test("passes the entry's data through unchanged", () => {
    const data = { diagnostics: [{ tool: "run_tests", ok: false }] };
    const view = projectEntry(entryRecord({ id: 12, kind: "toolResult", model: [], data }));

    expect(view.data).toEqual(data);
  });

  test("a display entry with neither model nor data projects to empty text", () => {
    const view = projectEntry(entryRecord({ id: 13, kind: "bookkeeping" }));

    expect(view.text).toBe("");
    expect(view.role).toBe("system");
    expect(view.data).toBeUndefined();
  });
});

describe("usageView", () => {
  test("sums every model bucket and counts the exchanges", () => {
    const view = usageView({
      models: {
        "opencode-go/deepseek-v4-pro": { input: 1_000, output: 200 },
        "cloudflare/@cf/meta/llama-3.1-8b-instruct": { input: 50, output: 5 },
      },
    });

    expect(view).toEqual({ inputTokens: 1_050, outputTokens: 205, exchanges: 2 });
  });

  test("ignores the counters a view does not show", () => {
    const view = usageView({
      models: {
        "openrouter/longcat-2.5-preview-free": {
          input: 10,
          output: 2,
          cacheRead: 900,
          cacheWrite: 0,
          cost: 0.42,
        },
      },
    });

    expect(view).toEqual({ inputTokens: 10, outputTokens: 2, exchanges: 1 });
  });

  test.each([
    ["undefined", undefined],
    ["an empty object", {}],
    ["an empty model table", { models: {} }],
    ["a document with no models key", { other: 1 }],
  ])("reads %s as zero spend", (_label, state) => {
    expect(usageView(state)).toEqual({ inputTokens: 0, outputTokens: 0, exchanges: 0 });
  });

  test.each([
    ["a bucket without output", { models: { a: { input: 10 } } }],
    [
      "one malformed bucket beside a good one",
      { models: { a: { input: 1, output: 2 }, b: { input: 3 } } },
    ],
    ["a model table that is not a table", { models: "deepseek-v4-pro" }],
    ["non-numeric counters", { models: { a: { input: "10", output: 2 } } }],
  ])("does not throw on %s", (_label, state) => {
    expect(usageView(state)).toEqual({ inputTokens: 0, outputTokens: 0, exchanges: 0 });
  });
});

describe("inboxView", () => {
  const state = {
    items: [
      {
        id: 10,
        mode: "followUp",
        content: [textBlock("Run "), textBlock("the tests.")],
      },
      { id: 2, mode: "steer", content: "Stop after this file." },
      { id: 7, mode: "write", content: [] },
      { id: 3, mode: "note", content: "not a queued item" },
      { id: 4, mode: "followUp" },
    ],
  };

  test("keeps the three modes a boundary understands and drops the rest", () => {
    expect(inboxView(state).map((item) => [item.id, item.mode])).toEqual([
      ["10", "followUp"],
      ["2", "steer"],
      ["7", "write"],
      ["4", "followUp"],
    ]);
  });

  test("joins text blocks and omits text when there is none", () => {
    expect(inboxView(state).map((item) => item.text)).toEqual([
      "Run the tests.",
      "Stop after this file.",
      undefined,
      undefined,
    ]);
  });

  test("orders ids as strings, preserving pi's item order", () => {
    const items = inboxView({
      items: [
        { id: 9, mode: "steer" },
        { id: 100, mode: "write" },
      ],
    });

    expect(items.map((item) => item.id)).toEqual(["9", "100"]);
  });

  test.each([
    ["an unknown state", undefined],
    ["an items field that is not a list", { items: "none" }],
    ["an item whose id is not a number", { items: [{ id: "10", mode: "steer" }] }],
    ["an item with an unknown mode only", { items: [{ id: 1, mode: "note" }] }],
  ])("returns no items for %s", (_label, state) => {
    expect(inboxView(state)).toEqual([]);
  });
});

describe("liveView", () => {
  const operationOf = (input: string): string => (input === "10" ? "http:req-10" : "");

  test("maps the run's first input to its operation and stringifies every input", () => {
    const view = liveView({ run: { inputs: [10, 11] } }, operationOf);

    expect(view.run).toEqual({ operationId: "http:req-10", inputs: ["10", "11"] });
  });

  test("passes the stringified first input to the operation reader", () => {
    const seen: string[] = [];
    liveView({ run: { inputs: [10, 11] } }, (input) => {
      seen.push(input);
      return "http:req-10";
    });

    expect(seen).toEqual(["10"]);
  });

  test("an empty input list still reports a run with no operation", () => {
    expect(liveView({ run: { inputs: [] } }, operationOf)).toMatchObject({
      run: { operationId: "", inputs: [] },
    });
  });

  test("reports no run when pi has none", () => {
    expect(liveView({}, operationOf).run).toBeUndefined();
  });

  test("extracts text and thinking from the partial response", () => {
    const view = liveView(
      {
        run: { inputs: [10] },
        generation: {
          attempt: 2,
          message: {
            content: [
              thinkingBlock("Plan "),
              thinkingBlock("the page."),
              textBlock("Writ"),
              textBlock("ing."),
              { type: "toolCall", id: "call_1", name: "read_file", arguments: {} },
            ],
          },
          retry: { at: TIMESTAMP, error: "rate limited" },
        },
      },
      operationOf,
    );

    expect(view.generation).toEqual({
      attempt: 2,
      text: "Writing.",
      thinking: "Plan the page.",
      retry: { at: TIMESTAMP, error: "rate limited" },
    });
  });

  test("omits text and thinking when the partial response has none", () => {
    const view = liveView(
      {
        generation: {
          attempt: 1,
          message: { content: [thinkingBlock(""), textBlock(""), { type: "toolCall" }] },
        },
      },
      operationOf,
    );

    expect(view.generation?.text).toBeUndefined();
    expect(view.generation?.thinking).toBeUndefined();
  });

  test("maps tools, compactions and a compaction failure", () => {
    const view = liveView(
      {
        tools: [
          {
            callId: "call_1",
            name: "read_file",
            status: "running",
            output: "partial",
            details: { path: "README.md" },
          },
          { callId: "call_2", name: "list_dir", status: "pending" },
        ],
        compactions: [{ taskId: 42, reason: "context_window", blocking: true }],
        compactionFailure: { taskId: 43, reason: "compaction", error: "out of budget" },
      },
      operationOf,
    );

    expect(view.tools).toEqual([
      {
        callId: "call_1",
        name: "read_file",
        status: "running",
        output: "partial",
        details: { path: "README.md" },
      },
      {
        callId: "call_2",
        name: "list_dir",
        status: "pending",
        output: undefined,
        details: undefined,
      },
    ]);
    expect(view.compactions).toEqual([{ taskId: "42", reason: "context_window", blocking: true }]);
    expect(view.compactionFailure).toEqual({
      taskId: "43",
      reason: "compaction",
      error: "out of budget",
    });
  });

  test("decodes an empty document to an empty view", () => {
    const view = liveView({}, operationOf);

    expect(view.run).toBeUndefined();
    expect(view.generation).toBeUndefined();
    expect(view.tools).toEqual([]);
    expect(view.compactions).toEqual([]);
    expect(view.compactionFailure).toBeUndefined();
  });

  test.each([
    ["run inputs that are strings", { run: { inputs: ["10"] } }],
    ["a tools field that is not a list", { tools: "read_file" }],
    ["an unknown tool status", { tools: [{ callId: "c", name: "n", status: "paused" }] }],
    [
      "a compaction with a string task id",
      { compactions: [{ taskId: "1", reason: "x", blocking: false }] },
    ],
  ])("does not throw on %s", (_label, state) => {
    const view = liveView(state, operationOf);

    expect(view.tools).toEqual([]);
    expect(view.compactions).toEqual([]);
  });
});

describe("streamIdFor and streamView", () => {
  test("names a feed segment by session and generation", () => {
    expect(streamIdFor("bot-1", 3)).toBe("feed:bot-1:3");
    expect(streamIdFor("root", 0)).toBe("feed:root:0");
    expect(streamIdFor("bot-1", 3)).not.toBe(streamIdFor("bot-1", 4));
  });

  test("defaults a stream view to streaming at its cursor", () => {
    expect(streamView("bot-1", 3, 17)).toEqual({
      stream: "feed:bot-1:3",
      generation: 3,
      cursor: 17,
      state: "streaming",
    });
  });

  test.each(["completed", "errored"] as const)("carries the %s state", (state) => {
    expect(streamView("bot-1", 0, 0, state).state).toBe(state);
  });
});

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

  test("an entry's origin agrees with the operation that owns it", () => {
    const run = runFor("delegate:task-7", 20, 30);
    const view: EntryView = projectEntry(
      entryRecord({ id: 25, kind: "assistant", model: [assistantMessage([textBlock("done")])] }),
      runOfEntry(25, [run]),
    );

    expect(view.origin).toBe("delegate");
    expect(view.text).toBe("done");
  });
});
