/**
 * Smoke test for the shared wire contract (src/web-contract.ts).
 *
 * Run with: bun tests/web-contract.smoke.mjs
 *
 * Two claims, both checkable without a Worker or a browser:
 *   1. `encodeFrame` is total over the harness event vocabulary — every
 *      `AgentEvent` type maps to a Frame or to a deliberate `undefined`.
 *      (tsc owns the exhaustiveness proof; this owns the runtime behaviour.)
 *   2. Every Frame that `encodeFrame` produces is a member of `FrameSchema` and
 *      survives a JSON round trip, which is what makes it a `StreamJson` chunk.
 */
const { FrameSchema, encodeFrame, encodeSnapshot, projectEntry, usageView } = await import(
  "../src/web-contract.ts"
);
const Schema = await import("effect/Schema");

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
};

const usage = {
  input: 10,
  output: 4,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 14,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistant = {
  role: "assistant",
  content: [{ type: "text", text: "hello" }],
  api: "openai",
  provider: "opencode-go",
  model: "deepseek-v4-pro",
  usage,
  stopReason: "stop",
  timestamp: 1,
};

const userEntry = { id: 1, conversationId: 7, kind: "pi.user", model: [{ role: "user", content: "hi", timestamp: 1 }] };
const assistantEntry = { id: 2, conversationId: 7, kind: "pi.assistant", model: [assistant] };
const submission = { id: 3, conversationId: 7, type: "input", status: "queued", requestId: "http:abc" };

const emptyUsageState = { models: {}, tools: {} };

const events = {
  snapshot: {
    type: "snapshot",
    entries: [userEntry, assistantEntry],
    run: { inputs: [1] },
    generation: { attempt: 1, message: assistant, retry: { at: 5, error: "x" } },
    tools: [],
    nestedTools: [],
    compactions: [],
    inbox: [{ id: 4, mode: "followUp" }],
    agent: {},
    usage: emptyUsageState,
  },
  run_start: { type: "run_start", inputs: [1] },
  run_end: { type: "run_end", inputs: [1] },
  turn_start: { type: "turn_start" },
  turn_end: { type: "turn_end" },
  message_start: { type: "message_start", message: assistant },
  message_update: {
    type: "message_update",
    usage,
    changes: [{ type: "text_delta", contentIndex: 0, delta: "he" }],
  },
  message_end: { type: "message_end", entry: assistantEntry },
  tool_execution_start: {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "botmail.send",
    args: { to: "a@b.c" },
  },
  tool_execution_update: {
    type: "tool_execution_update",
    toolCallId: "call-1",
    toolName: "botmail.send",
    output: { append: "chunk" },
  },
  tool_execution_end: {
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "botmail.send",
    entry: { id: 9, conversationId: 7, kind: "pi.tool-result", model: [] },
  },
  inbox_update: { type: "inbox_update", items: [{ id: 4, mode: "steer" }] },
  submission: { type: "submission", record: submission },
  auto_retry_start: { type: "auto_retry_start", attempt: 1, at: 5, errorMessage: "boom" },
  auto_retry_end: { type: "auto_retry_end", attempt: 1 },
  deferred_poll: { type: "deferred_poll", pollAt: 9 },
  entry_appended: { type: "entry_appended", entry: userEntry },
  agent_changed: { type: "agent_changed", agent: {} },
  usage_changed: { type: "usage_changed", usage: emptyUsageState },
  task_failed: { type: "task_failed", taskId: 5, kind: "pi.generation", message: "boom" },
  compaction_start: { type: "compaction_start", taskId: 5, reason: "manual", blocking: false },
  compaction_end: { type: "compaction_end", taskId: 5, reason: "manual" },
};

const encodable = Schema.encodeSync(FrameSchema);

const expectKind = {
  snapshot: "snapshot",
  run_start: "run",
  run_end: "run",
  turn_start: "turn",
  turn_end: "turn",
  message_start: "message",
  message_update: "delta",
  message_end: "message",
  tool_execution_start: "tool",
  tool_execution_update: "tool",
  tool_execution_end: "tool",
  inbox_update: "inbox",
  submission: "submission",
  entry_appended: "message",
  usage_changed: "usage",
  task_failed: "task_failed",
};

const unrendered = new Set([
  "auto_retry_start",
  "auto_retry_end",
  "deferred_poll",
  "agent_changed",
  "compaction_start",
  "compaction_end",
]);

check("corpus covers the event vocabulary", Object.keys(events).length === 22, `${Object.keys(events).length}`);

for (const [type, event] of Object.entries(events)) {
  let frame;
  try {
    frame = encodeFrame(event, 1_000, 1);
  } catch (error) {
    failures.push(`encodeFrame threw for ${type}: ${error?.message ?? error}`);
    continue;
  }
  if (unrendered.has(type)) {
    check(`unrendered ${type} yields no frame`, frame === undefined);
    continue;
  }
  check(`${type} yields a frame`, frame !== undefined);
  if (frame === undefined) continue;
  check(`${type} kind`, frame.kind === expectKind[type], `got ${frame.kind}`);
  try {
    encodable(frame);
  } catch (error) {
    failures.push(`frame for ${type} is not a Frame: ${JSON.stringify(error?.message ?? error)}`);
  }
  const round = JSON.parse(JSON.stringify(frame));
  try {
    Schema.decodeUnknownSync(FrameSchema)(round);
  } catch (error) {
    failures.push(`frame for ${type} does not decode after JSON: ${error?.message ?? error}`);
  }
}

// The snapshot arm carries the session the caller seeds, not one guessed from
// the transcript: an explicit session must survive encoding.
const seeded = encodeSnapshot(events.snapshot, "thread-1", 2_000, 3);
check("snapshot session is explicit", seeded.session === "thread-1", seeded.session);
check("snapshot generation", seeded.generation === 3);
check("snapshot transcriptFrom is the oldest entry", seeded.transcriptFrom === 1, `${seeded.transcriptFrom}`);
check("snapshot tail carries the retry", seeded.tail?.retryAt === 5);

check("projectEntry joins a run window", projectEntry(userEntry, { ordinal: 1, operationId: "cron:x", startedAt: 42 }).at === 42);
check("projectEntry without a run has no time", projectEntry(userEntry).at === undefined);
check(
  "projectEntry derives the origin from the run's operation id",
  projectEntry(userEntry, { ordinal: 1, operationId: "cron:x", startedAt: 42 }).origin === "cron",
);
check(
  "projectEntry renders message text",
  projectEntry(assistantEntry).text === "hello",
  projectEntry(assistantEntry).text,
);

const usageState = { models: { "opencode-go/deepseek": usage }, tools: {} };
check("usageView sums the model ledger", usageView(usageState).inputTokens === 10);
check("usageView counts the model ledgers", usageView(usageState).exchanges === 1);

const { TranscriptQuerySchema, EventsQuerySchema, ApprovalDecisionSchema, SessionRequestSchema } =
  await import("../src/web-contract.ts");

check("transcript limit accepts 200", Schema.decodeUnknownSync(TranscriptQuerySchema)({ limit: "200" }).limit === 200);
check("transcript limit rejects 0", !Schema.is(TranscriptQuerySchema)({ limit: "0" }));
check("events from accepts 2", Schema.decodeUnknownSync(EventsQuerySchema)({ from: "2", gen: "0" }).from === 2);
check("events gen rejects -1", !Schema.is(EventsQuerySchema)({ gen: "-1" }));
check("approval decision accepts allow", Schema.decodeUnknownSync(ApprovalDecisionSchema)({ action: "allow" }).action === "allow");
check("approval decision rejects maybe", !Schema.is(ApprovalDecisionSchema)({ action: "maybe" }));
check("session code is non-empty", !Schema.is(SessionRequestSchema)({ code: "" }));

if (failures.length > 0) {
  console.error("web-contract smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("web-contract smoke passed");
process.exit(0);
