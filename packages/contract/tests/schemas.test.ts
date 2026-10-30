/**
 * The wire schemas both the Worker and the browser decode. Each test pins a
 * boundary the front door relies on: what it accepts, and what it must refuse.
 */

import * as Schema from "effect/Schema";
import { describe, expect, test } from "vitest";

import { MODEL_VARIANTS } from "../src/catalog.ts";
import {
  ApprovalDecisionSchema,
  BotConfigSchema,
  BotIdSchema,
  CompactRequestSchema,
  DEFAULT_LIMIT,
  EventsQuerySchema,
  FrameSchema,
  MAX_LIMIT,
  THREAD_TITLE_MAX,
  ThreadListSchema,
  ThreadsQuerySchema,
  ThreadUpdateSchema,
  TranscriptQuerySchema,
  trimmedNonEmpty,
} from "../src/index.ts";
import type {
  ApprovalDecision,
  BotConfig,
  BotId,
  CompactRequest,
  EventsQuery,
  Frame,
  ThreadList,
  ThreadUpdate,
  TranscriptQuery,
} from "../src/index.ts";

/** A fixed wall clock, so a frame that carries a timestamp stays deterministic. */
const TIMESTAMP = 1_764_000_000_000;

type Decoder = Parameters<typeof Schema.decodeUnknownSync>[0];

const accept = <T>(schema: Decoder, input: Schema.Json): T =>
  // SAFETY: the caller picks `T` to match the schema it passed, which is the
  // shape this decoder returns for a valid input.
  Schema.decodeUnknownSync(schema)(input) as T;

const reject = (schema: Decoder, input: Schema.Json): void => {
  expect(() => Schema.decodeUnknownSync(schema)(input)).toThrow();
};

const SIXTY_THREE_AS = "a".repeat(63);

describe("trimmedNonEmpty", () => {
  test.each(["x", " a ", "0"])("accepts %j", (input) => {
    expect(accept<string>(trimmedNonEmpty, input)).toBe(input);
  });

  test.each(["", " ", "   ", "\t", "\n", " \n\t "])("rejects %j", (input) => {
    reject(trimmedNonEmpty, input);
  });
});

describe("BotIdSchema", () => {
  test.each(["mackbot", "a", "9", "bot-2", "scout-2026", SIXTY_THREE_AS])(
    "accepts the slug %j",
    (input) => {
      expect(accept<BotId>(BotIdSchema, input)).toBe(input);
    },
  );

  test.each([
    "",
    "Mackbot",
    "mack bot",
    "-mack",
    "_mack",
    "mack_bot",
    "mack.bot",
    "mack/bot",
    "mackbot ",
    " mackbot",
    "mackbot\n",
    "a".repeat(64),
  ])("rejects %j", (input) => {
    reject(BotIdSchema, input);
  });
});

describe("BotConfigSchema", () => {
  test("accepts a fully declared bot", () => {
    // `@cf/...` is how a Workers AI model is spelled in the same field.
    const bot = accept<BotConfig>(BotConfigSchema, {
      model: "@cf/meta/llama-3.1-8b-instruct",
      systemPrompt: "You are Mack, the fleet's operator.",
      thinkingLevel: "max",
      brief: "Keeps the fleet honest.",
      delegatesTo: ["scout", "builder"],
      runtime: {
        contextWindow: 128_000,
        reserveTokens: 4_096,
        maxRetries: 3,
        parallelTools: true,
        restartLimit: 2,
      },
      commitments: true,
    });

    expect(bot.model).toBe("@cf/meta/llama-3.1-8b-instruct");
    expect(bot.thinkingLevel).toBe("max");
    expect(bot.delegatesTo).toEqual(["scout", "builder"]);
    expect(bot.runtime).toEqual({
      contextWindow: 128_000,
      reserveTokens: 4_096,
      maxRetries: 3,
      parallelTools: true,
      restartLimit: 2,
    });
    expect(bot.commitments).toBe(true);
  });

  test("accepts a catalog id with no optional fields", () => {
    const bot = accept<BotConfig>(BotConfigSchema, {
      model: "deepseek-v4-pro",
      systemPrompt: "Answer briefly.",
    });

    expect(bot.model).toBe("deepseek-v4-pro");
    expect(bot.thinkingLevel).toBeUndefined();
    expect(bot.delegatesTo).toBeUndefined();
    expect(bot.runtime).toBeUndefined();
  });

  test.each([
    ["blank model", { model: "", systemPrompt: "Answer briefly." }],
    ["whitespace model", { model: " \t\n ", systemPrompt: "Answer briefly." }],
    ["blank prompt", { model: "deepseek-v4-pro", systemPrompt: "   " }],
    ["missing model", { systemPrompt: "Answer briefly." }],
    ["missing prompt", { model: "deepseek-v4-pro" }],
    [
      "unknown thinking level",
      { model: "deepseek-v4-pro", systemPrompt: "x", thinkingLevel: "turbo" },
    ],
    ["blank brief", { model: "deepseek-v4-pro", systemPrompt: "x", brief: " " }],
    [
      "blank delegate",
      { model: "deepseek-v4-pro", systemPrompt: "x", delegatesTo: ["scout", " "] },
    ],
    [
      "non-numeric runtime field",
      { model: "deepseek-v4-pro", systemPrompt: "x", runtime: { maxRetries: "3" } },
    ],
    [
      "non-boolean commitments",
      { model: "deepseek-v4-pro", systemPrompt: "x", commitments: "yes" },
    ],
  ])("rejects a %s", (_label, input) => {
    reject(BotConfigSchema, input);
  });

  test("accepts every thinking level the catalog declares", () => {
    const declared = new Set(Object.values(MODEL_VARIANTS).flat());
    for (const level of declared) {
      expect(() =>
        Schema.decodeUnknownSync(BotConfigSchema)({
          model: "claude-haiku-5-5",
          systemPrompt: "x",
          thinkingLevel: level,
        }),
      ).not.toThrow();
    }
  });
});

describe("TranscriptQuerySchema", () => {
  test("leaves an absent limit absent", () => {
    const query = accept<TranscriptQuery>(TranscriptQuerySchema, {});

    expect(query.limit).toBeUndefined();
    expect(Object.keys(query)).not.toContain("limit");
  });

  test.each([
    ["1", 1],
    ["50", 50],
    [String(DEFAULT_LIMIT), DEFAULT_LIMIT],
    ["200", MAX_LIMIT],
  ])("decodes limit %j", (limit, expected) => {
    expect(accept<TranscriptQuery>(TranscriptQuerySchema, { limit }).limit).toBe(expected);
  });

  test.each([["0"], ["201"], ["-1"], ["1.5"], ["abc"], [""], ["201"], ["NaN"]])(
    "rejects limit %j",
    (limit) => {
      reject(TranscriptQuerySchema, { limit });
    },
  );

  test("decodes an exclusive before cursor", () => {
    expect(accept<TranscriptQuery>(TranscriptQuerySchema, { before: "12" }).before).toBe(12);
    expect(accept<TranscriptQuery>(TranscriptQuerySchema, { before: "1" }).before).toBe(1);
  });

  test.each([["0"], ["-3"], ["2.5"], ["NaN"], ["nope"], [""]])("rejects before %j", (before) => {
    reject(TranscriptQuerySchema, { before });
  });

  test("keeps a real thread and rejects a blank one", () => {
    expect(accept<TranscriptQuery>(TranscriptQuerySchema, { thread: "thread-abc" }).thread).toBe(
      "thread-abc",
    );
    reject(TranscriptQuerySchema, { thread: "   " });
    reject(TranscriptQuerySchema, { thread: "" });
  });

  test("decodes the whole query together", () => {
    expect(
      accept<TranscriptQuery>(TranscriptQuerySchema, {
        thread: "thread-abc",
        before: "900",
        limit: "25",
      }),
    ).toEqual({ thread: "thread-abc", before: 900, limit: 25 });
  });
});

describe("EventsQuerySchema", () => {
  test("accepts zero for both cursors", () => {
    const query = accept<EventsQuery>(EventsQuerySchema, { gen: "0", from: "0" });

    expect(query.gen).toBe(0);
    expect(query.from).toBe(0);
  });

  test("decodes a generation and a cursor", () => {
    expect(accept<EventsQuery>(EventsQuerySchema, { gen: "7", from: "1234" })).toEqual({
      gen: 7,
      from: 1234,
    });
  });

  test("leaves both cursors absent by default", () => {
    const query = accept<EventsQuery>(EventsQuerySchema, {});

    expect(query.gen).toBeUndefined();
    expect(query.from).toBeUndefined();
  });

  test.each([
    ["gen", "-1"],
    ["gen", "1.5"],
    ["gen", "nope"],
    ["from", "-1"],
    ["from", "2.5"],
    ["from", "nope"],
  ])("rejects %s %j", (field, value) => {
    reject(EventsQuerySchema, { [field]: value });
  });

  // `?from=` (an empty value, not an absent one) arrives as "". `Number("")`
  // is `0`, so the schema has to refuse it explicitly; otherwise the feed's
  // resume cursor silently means "replay from the start" instead of falling
  // back to `Last-Event-ID`.
  test("rejects an empty from cursor rather than reading it as 0", () => {
    reject(EventsQuerySchema, { from: "" });
    reject(EventsQuerySchema, { gen: "" });
  });

  test("rejects a blank thread", () => {
    reject(EventsQuerySchema, { thread: "\t " });
  });
});

describe("CompactRequestSchema", () => {
  test("accepts a request with no instructions", () => {
    const request = accept<CompactRequest>(CompactRequestSchema, {});

    expect(request.instructions).toBeUndefined();
    expect(Object.keys(request)).not.toContain("instructions");
  });

  test("accepts a session and real instructions", () => {
    expect(
      accept<CompactRequest>(CompactRequestSchema, {
        session: "thread-abc",
        instructions: "Keep the open decisions.",
      }),
    ).toEqual({ session: "thread-abc", instructions: "Keep the open decisions." });
  });

  test.each(["", "   ", "\n\t "])("rejects blank instructions %j", (instructions) => {
    reject(CompactRequestSchema, { instructions });
  });

  test("rejects a non-string session", () => {
    reject(CompactRequestSchema, { session: 3 });
  });
});

describe("ApprovalDecisionSchema", () => {
  test.each(["allow", "deny"])("accepts the action %j", (action) => {
    expect(accept<ApprovalDecision>(ApprovalDecisionSchema, { action }).action).toBe(action);
  });

  test.each(["approve", "ALLOW", "", "denied"])("rejects the action %j", (action) => {
    reject(ApprovalDecisionSchema, { action });
  });

  test("accepts each content value shape", () => {
    const content = {
      command: "bun run test",
      timeoutMs: 30_000,
      sandboxed: true,
      args: ["--watch", "-u"],
    };
    const decision = accept<ApprovalDecision>(ApprovalDecisionSchema, {
      action: "allow",
      content,
    });

    expect(decision.content).toEqual(content);
  });

  test.each([
    ["an object value", { nested: { deep: true } }],
    ["a null value", { value: null }],
    ["an array of non-strings", { args: ["ok", 1] }],
    ["a nested array", { args: [["ok"]] }],
  ])("rejects %s", (_label, content) => {
    reject(ApprovalDecisionSchema, { action: "allow", content });
  });
});

// ---------------------------------------------------------------------------
// Frames — one realistic value per kind, and the boundaries the union refuses
// ---------------------------------------------------------------------------

const snapshotFrame = () => ({
  kind: "snapshot",
  generation: 4,
  at: TIMESTAMP,
  session: "root",
  entries: [
    {
      id: 41,
      kind: "user",
      role: "user",
      text: "Ship the release.",
      at: TIMESTAMP - 2_000,
      origin: "http",
    },
    {
      id: 42,
      kind: "assistant",
      role: "assistant",
      text: "Shipped.",
      at: TIMESTAMP - 1_000,
      origin: "http",
    },
  ],
  live: {
    run: { operationId: "http:req-42", inputs: ["42"] },
    generation: { attempt: 1, text: "Shipp", thinking: "Plan the release." },
    tools: [
      { callId: "call_1", name: "deploy", status: "done", output: "ok", details: { region: "eu" } },
    ],
    compactions: [{ taskId: "12", reason: "context_window", blocking: false }],
    compactionFailure: { taskId: "13", reason: "compaction", error: "out of budget" },
  },
  inbox: [{ id: "77", mode: "followUp", text: "Also update the docs." }],
  usage: { inputTokens: 1_200, outputTokens: 340, exchanges: 3 },
  transcriptFrom: 41,
});

describe("FrameSchema", () => {
  test("decodes a snapshot frame", () => {
    const frame = accept<Frame>(FrameSchema, snapshotFrame());

    expect(frame.kind).toBe("snapshot");
    if (frame.kind !== "snapshot") return;
    expect(frame.generation).toBe(4);
    expect(frame.session).toBe("root");
    expect(frame.transcriptFrom).toBe(41);
    expect(frame.entries.map((entry) => entry.id)).toEqual([41, 42]);
    expect(frame.live.run?.operationId).toBe("http:req-42");
    expect(frame.live.generation?.text).toBe("Shipp");
    expect(frame.live.tools[0]?.name).toBe("deploy");
    expect(frame.live.compactions[0]?.taskId).toBe("12");
    expect(frame.live.compactionFailure?.taskId).toBe("13");
    expect(frame.inbox[0]?.mode).toBe("followUp");
    expect(frame.usage).toEqual({ inputTokens: 1_200, outputTokens: 340, exchanges: 3 });
  });

  test("decodes an append frame", () => {
    const frame = accept<Frame>(FrameSchema, {
      kind: "append",
      at: TIMESTAMP,
      entries: [
        {
          id: 43,
          kind: "toolResult",
          role: "tool",
          text: "read 3 files",
          toolName: "read_file",
          toolFailed: false,
        },
      ],
    });

    expect(frame.kind).toBe("append");
    if (frame.kind !== "append") return;
    expect(frame.entries[0]).toMatchObject({
      id: 43,
      role: "tool",
      toolName: "read_file",
      toolFailed: false,
    });
  });

  test("decodes a live frame", () => {
    const frame = accept<Frame>(FrameSchema, {
      kind: "live",
      at: TIMESTAMP,
      live: {
        generation: { attempt: 2, thinking: "Reconsider." },
        tools: [{ callId: "call_9", name: "grep", status: "running" }],
        compactions: [],
      },
    });

    expect(frame.kind).toBe("live");
    if (frame.kind !== "live") return;
    expect(frame.live.generation?.attempt).toBe(2);
    expect(frame.live.tools[0]?.status).toBe("running");
    expect(frame.live.run).toBeUndefined();
  });

  test("decodes an inbox frame", () => {
    const frame = accept<Frame>(FrameSchema, {
      kind: "inbox",
      at: TIMESTAMP,
      items: [
        { id: "78", mode: "steer", text: "Stop after this file." },
        { id: "79", mode: "write" },
      ],
    });

    expect(frame.kind).toBe("inbox");
    if (frame.kind !== "inbox") return;
    expect(frame.items.map((item) => item.id)).toEqual(["78", "79"]);
  });

  test("decodes a usage frame", () => {
    const frame = accept<Frame>(FrameSchema, {
      kind: "usage",
      at: TIMESTAMP,
      usage: { inputTokens: 40, outputTokens: 8, exchanges: 1 },
    });

    expect(frame.kind).toBe("usage");
    if (frame.kind !== "usage") return;
    expect(frame.usage).toEqual({ inputTokens: 40, outputTokens: 8, exchanges: 1 });
  });

  test.each(["start", "end"])("decodes a run frame in phase %j", (phase) => {
    const frame = accept<Frame>(FrameSchema, {
      kind: "run",
      phase,
      at: TIMESTAMP,
      operationId: "cron:nightly",
    });

    expect(frame.kind).toBe("run");
    if (frame.kind !== "run") return;
    expect(frame.phase).toBe(phase);
    expect(frame.operationId).toBe("cron:nightly");
  });

  test("decodes a task_failed frame", () => {
    const frame = accept<Frame>(FrameSchema, {
      kind: "task_failed",
      taskId: "91",
      task: "compaction",
      message: "context could not be compacted",
    });

    expect(frame).toEqual({
      kind: "task_failed",
      taskId: "91",
      task: "compaction",
      message: "context could not be compacted",
    });
  });

  test("rejects an unknown kind", () => {
    reject(FrameSchema, { kind: "resume", at: TIMESTAMP, generation: 1 });
  });

  test("rejects a snapshot without a generation", () => {
    const { generation: _generation, ...withoutGeneration } = snapshotFrame();
    reject(FrameSchema, withoutGeneration);
  });

  test("rejects a snapshot whose live view is missing its tool list", () => {
    const frame = snapshotFrame();
    reject(FrameSchema, {
      ...frame,
      live: { run: frame.live.run },
    });
  });

  test("rejects a run frame in a phase other than start or end", () => {
    reject(FrameSchema, {
      kind: "run",
      phase: "pause",
      at: TIMESTAMP,
      operationId: "http:req-1",
    });
  });

  test("rejects a task_failed frame with no message", () => {
    reject(FrameSchema, { kind: "task_failed", taskId: "91", task: "compaction" });
  });

  test("rejects an append frame whose entries are not a list", () => {
    reject(FrameSchema, { kind: "append", at: TIMESTAMP, entries: "entry" });
  });
});

describe("ThreadsQuerySchema", () => {
  test("no query lists the live threads, and include=archived asks for the rest", () => {
    expect(accept(ThreadsQuerySchema, {})).toEqual({});
    expect(accept(ThreadsQuerySchema, { include: "archived" })).toEqual({ include: "archived" });
  });

  test.each(["all", "", "ARCHIVED"])("rejects include=%j", (include) => {
    reject(ThreadsQuerySchema, { include });
  });
});

describe("ThreadUpdateSchema", () => {
  test("accepts an archive, a restore and a rename", () => {
    expect(accept<ThreadUpdate>(ThreadUpdateSchema, { archived: true })).toEqual({
      archived: true,
    });
    expect(accept<ThreadUpdate>(ThreadUpdateSchema, { archived: false, title: "Plan" })).toEqual({
      archived: false,
      title: "Plan",
    });
  });

  test("a title may be as long as the ceiling and no longer", () => {
    accept(ThreadUpdateSchema, { title: "x".repeat(THREAD_TITLE_MAX) });
    reject(ThreadUpdateSchema, { title: "x".repeat(THREAD_TITLE_MAX + 1) });
  });

  test.each<Schema.Json>([{ title: "   " }, { title: "" }, { archived: "true" }])(
    "rejects %j",
    (input) => {
      reject(ThreadUpdateSchema, input);
    },
  );
});

describe("ThreadListSchema", () => {
  test("the root conversation is the one entry without a thread id", () => {
    const list = accept<ThreadList>(ThreadListSchema, {
      bot: "hermes",
      threads: [
        { session: "1", archived: false, busy: false, pendingApprovals: 1 },
        {
          thread: "plan",
          session: "3",
          title: "Plan the week",
          createdAt: TIMESTAMP,
          lastActivityAt: TIMESTAMP,
          archived: false,
          busy: true,
          pendingApprovals: 0,
        },
      ],
    });
    expect(list.threads.map((view) => view.thread)).toEqual([undefined, "plan"]);
  });

  test("rejects a thread that does not say whether it is busy", () => {
    reject(ThreadListSchema, {
      bot: "hermes",
      threads: [{ session: "1", archived: false, pendingApprovals: 0 }],
    });
  });
});
