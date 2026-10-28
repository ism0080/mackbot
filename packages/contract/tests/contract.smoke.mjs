/**
 * Smoke test for the shared wire contract (packages/contract).
 *
 * Run with: bun packages/contract/tests/contract.smoke.mjs
 *
 * The claims this file has to break if they stop holding:
 *   1. Every Frame the feed emits is a member of `FrameSchema` and survives a
 *      JSON round trip, which is what makes it a `StreamJson` chunk.
 *   2. The projections read pi's committed documents rather than re-encoding
 *      them: `liveView` keeps the running partial, the tools and the compaction
 *      status; `inboxView` keeps the queue; `projectEntry` joins the origin of
 *      the submission that admitted the entry.
 *   3. A run window is derived from the input and answer entry ids a submission
 *      records, and the newest containing window owns an entry.
 */
const {
  FrameSchema,
  ApprovalViewSchema,
  inboxView,
  liveView,
  projectEntry,
  runOfEntry,
  streamIdFor,
  streamView,
  usageView,
} = await import("@mackbot/contract");
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

const userEntry = {
  id: 1,
  conversationId: 7,
  kind: "pi.user",
  model: [{ role: "user", content: "hi", timestamp: 1 }],
};
const assistantEntry = { id: 2, conversationId: 7, kind: "pi.assistant", model: [assistant] };

const emptyUsageState = { models: {}, tools: {} };
const live = {
  run: { taskId: 5, inputs: [3] },
  generation: { attempt: 2, message: assistant, retry: { at: 5, error: "x" } },
  tools: [{ callId: "call-1", name: "botmail.send", status: "running", output: "sent" }],
  compactions: [{ taskId: 6, reason: "manual", blocking: false, attempt: 1 }],
  compactionFailure: { taskId: 7, reason: "threshold", error: "boom" },
};

const operationOf = (input) => (input === "3" ? "http:abc" : "");

// ---------------------------------------------------------------------------
// 1. Every emitted Frame is a contract value and survives the wire.
// ---------------------------------------------------------------------------

const frames = [
  {
    kind: "snapshot",
    generation: 3,
    at: 2_000,
    session: "thread-1",
    entries: [projectEntry(userEntry), projectEntry(assistantEntry)],
    live: liveView(live, operationOf),
    inbox: inboxView({ items: [{ id: 4, mode: "followUp" }] }),
    usage: usageView(emptyUsageState),
    transcriptFrom: 1,
  },
  { kind: "append", at: 2_000, entries: [projectEntry(assistantEntry)] },
  { kind: "live", at: 2_000, live: liveView(live, operationOf) },
  { kind: "inbox", at: 2_000, items: inboxView({ items: [{ id: 4, mode: "steer" }] }) },
  { kind: "usage", at: 2_000, usage: usageView(emptyUsageState) },
  { kind: "run", phase: "start", at: 2_000, operationId: "http:abc" },
  { kind: "run", phase: "end", at: 2_000, operationId: "http:abc" },
  { kind: "task_failed", taskId: "5", task: "pi.generation", message: "boom" },
];

const encodable = Schema.encodeSync(FrameSchema);
for (const frame of frames) {
  try {
    encodable(frame);
  } catch (error) {
    failures.push(
      `frame ${frame.kind}/${frame.phase ?? ""} is not a Frame: ${error?.message ?? error}`,
    );
    continue;
  }
  check(`${frame.kind}${frame.phase === undefined ? "" : ` ${frame.phase}`} is a Frame`, true);
  const round = JSON.parse(JSON.stringify(frame));
  try {
    Schema.decodeUnknownSync(FrameSchema)(round);
  } catch (error) {
    failures.push(`frame ${frame.kind} does not decode after JSON: ${error?.message ?? error}`);
  }
}

// The snapshot carries the session the caller seeds, not one guessed from the
// entries: an explicit session must survive.
const seeded = frames[0];
check("snapshot session is explicit", seeded.session === "thread-1", seeded.session);
check("snapshot generation", seeded.generation === 3);
check(
  "snapshot transcriptFrom is the oldest entry",
  seeded.transcriptFrom === 1,
  `${seeded.transcriptFrom}`,
);

// ---------------------------------------------------------------------------
// 2. The projections keep what pi committed.
// ---------------------------------------------------------------------------

const projected = liveView(live, operationOf);
check("liveView names the run's operation", projected.run?.operationId === "http:abc");
check("liveView keeps the run's inputs", projected.run?.inputs[0] === "3");
check("liveView keeps the streaming partial", projected.generation?.text === "hello");
check("liveView keeps the retry backoff", projected.generation?.retry?.at === 5);
check("liveView keeps the running tool", projected.tools[0]?.status === "running");
check("liveView keeps the tool output", projected.tools[0]?.output === "sent");
check("liveView keeps the compaction", projected.compactions[0]?.reason === "manual");
check(
  "liveView keeps the compaction failure",
  projected.compactionFailure?.error === "boom",
  projected.compactionFailure?.error,
);
check("liveView tolerates an absent document", liveView(undefined, operationOf).tools.length === 0);

const inbox = inboxView({ items: [{ id: 4, mode: "steer" }] });
check("inboxView keeps the queued item", inbox[0]?.id === "4");
check("inboxView keeps the mode", inbox[0]?.mode === "steer", `${inbox[0]?.mode}`);

check(
  "usageView sums the model ledger",
  usageView({ models: { "a/b": usage }, tools: {} }).inputTokens === 10,
);
check(
  "usageView counts the model ledgers",
  usageView({ models: { "a/b": usage }, tools: {} }).exchanges === 1,
);

check("projectEntry without a run has no time", projectEntry(userEntry).at === undefined);
check(
  "projectEntry renders user text",
  projectEntry(userEntry).text === "hi",
  projectEntry(userEntry).text,
);
check(
  "projectEntry renders assistant text",
  projectEntry(assistantEntry).text === "hello",
  projectEntry(assistantEntry).text,
);

// ---------------------------------------------------------------------------
// 3. A run window comes from the submission's entry and answer.
// ---------------------------------------------------------------------------

const runs = [
  { operationId: "http:first", startEntry: 1, answer: 4 },
  { operationId: "http:second", startEntry: 5 },
];
check("an answered window owns its entries", runOfEntry(2, runs)?.operationId === "http:first");
check("a live window owns its entries", runOfEntry(9, runs)?.operationId === "http:second");
check(
  "an entry outside every window has no run",
  runOfEntry(4, runs)?.operationId === "http:first",
);
check("the newest containing window wins", runOfEntry(5, runs)?.operationId === "http:second");
check(
  "projectEntry derives the origin from the run's operation id",
  projectEntry(userEntry, runs[0]).origin === "http",
  `${projectEntry(userEntry, runs[0]).origin}`,
);

// ---------------------------------------------------------------------------
// 4. The stream a client attaches to is named by the contract.
// ---------------------------------------------------------------------------

check("streamIdFor names the segment", streamIdFor("7", 3) === "feed:7:3");
check("streamView reports its generation", streamView("7", 3, 12).generation === 3);
check("streamView defaults to streaming", streamView("7", 3, 12).state === "streaming");

// The approval view is a status payload, not a frame, and never carries the
// DO-private request id.
const approval = {
  approvalId: "a-1",
  bot: "hermes",
  toolPath: "tools.github.listIssues",
  summary: "Approve it?",
  status: "pending",
  requestedAt: 1,
};
check("an approval view is not a Frame", !Schema.is(FrameSchema)({ kind: "approval", approval }));
check("an approval view decodes", Schema.is(ApprovalViewSchema)(approval));

// ---------------------------------------------------------------------------
// 5. Query schemas the routes decode.
// ---------------------------------------------------------------------------

const { TranscriptQuerySchema, EventsQuerySchema, ApprovalDecisionSchema, SessionRequestSchema } =
  await import("@mackbot/contract");

check(
  "transcript limit accepts 200",
  Schema.decodeUnknownSync(TranscriptQuerySchema)({ limit: "200" }).limit === 200,
);
check("transcript limit rejects 0", !Schema.is(TranscriptQuerySchema)({ limit: "0" }));
check(
  "events from accepts 2",
  Schema.decodeUnknownSync(EventsQuerySchema)({ from: "2", gen: "0" }).from === 2,
);
check("events gen rejects -1", !Schema.is(EventsQuerySchema)({ gen: "-1" }));
check(
  "approval decision accepts allow",
  Schema.decodeUnknownSync(ApprovalDecisionSchema)({ action: "allow" }).action === "allow",
);
check("approval decision rejects maybe", !Schema.is(ApprovalDecisionSchema)({ action: "maybe" }));
check("session code is non-empty", !Schema.is(SessionRequestSchema)({ code: "" }));

if (failures.length > 0) {
  console.error("contract smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("contract smoke passed");
process.exit(0);
