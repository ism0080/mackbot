/**
 * Smoke test for the Executor approval policy (src/executor-policy.ts).
 *
 * Run with: bun tests/executor-policy.smoke.mjs
 *
 * The prompt teaches the model never to invent an approval, but the harness has
 * to enforce it: a `executor_resume` for a requestId no human is still deciding
 * on must never run. The hook and the wrap are called directly here, so no
 * harness and no Executor are needed.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const { createExecutorPolicy } = await import("../src/executor-policy.ts");

const states = new Map([
  ["req-pending", "pending"],
  ["req-approved", "approved"],
  ["req-denied", "denied"],
]);
const reports = [];
const extension = createExecutorPolicy({
  approvalState: (requestId) => states.get(requestId) ?? "unknown",
  onCall: (call) => reports.push(call),
});

const beforeTool = extension.hooks[0].handlers.beforeTool;
const api = {};
const context = BACKGROUND_CONTEXT;
const call = (name, args) => ({ type: "toolCall", id: "call-1", name, arguments: args });

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
};

/** Whether a value is a string, without narrowing on its representation. */
const isText = (value) => Object.prototype.toString.call(value) === "[object String]";

check("extension name", extension.name === "executor-policy", `name is ${extension.name}`);
check("hook count", extension.hooks.length === 1, `found ${extension.hooks.length} hooks`);
check(
  "wrap targets",
  extension.wraps.length === 2 &&
    extension.wraps[0].tool === "executor_call" &&
    extension.wraps[1].tool === "executor_execute",
  `found ${extension.wraps.map((wrap) => wrap.tool).join(", ")}`,
);

// A resume nobody is waiting on is refused, and the refusal names the id.
const unknown = beforeTool(call("executor_resume", { requestId: "req-unknown" }), api, context);
check("unknown requestId blocked", isText(unknown?.block), `block is ${JSON.stringify(unknown)}`);
check(
  "unknown requestId named",
  (unknown?.block ?? "").includes("req-unknown"),
  `block is ${JSON.stringify(unknown?.block)}`,
);

// A human who has not answered yet cannot be pre-empted: resuming the call
// would run the effect before the answer.
const pending = beforeTool(call("executor_resume", { requestId: "req-pending" }), api, context);
check("pending requestId blocked", isText(pending?.block), `block is ${JSON.stringify(pending)}`);
check(
  "pending requestId named",
  (pending?.block ?? "").includes("req-pending"),
  `block is ${JSON.stringify(pending?.block)}`,
);

// An approval a human said yes to may be resumed: that is the decision being
// carried out.
const approved = beforeTool(
  call("executor_resume", { requestId: "req-approved", response: { action: "accept" } }),
  api,
  context,
);
check(
  "approved requestId allowed",
  approved === undefined,
  `hook returned ${JSON.stringify(approved)}`,
);

// A refusal may not be carried out. Telling Executor the human said no is
// fine; running the effect anyway is not.
const deniedAccept = beforeTool(
  call("executor_resume", { requestId: "req-denied", response: { action: "accept" } }),
  api,
  context,
);
check(
  "a refusal cannot be carried out",
  isText(deniedAccept?.block),
  `block is ${JSON.stringify(deniedAccept)}`,
);
check(
  "the refusal names the requestId",
  (deniedAccept?.block ?? "").includes("req-denied"),
  `block is ${JSON.stringify(deniedAccept?.block)}`,
);

const deniedDecline = beforeTool(
  call("executor_resume", { requestId: "req-denied", response: { action: "decline" } }),
  api,
  context,
);
check(
  "a refusal may be carried back to Executor",
  deniedDecline === undefined,
  `hook returned ${JSON.stringify(deniedDecline)}`,
);

// A requestId that is not a string names no approval.
const malformed = beforeTool(call("executor_resume", { requestId: 7 }), api, context);
check(
  "malformed requestId blocked",
  isText(malformed?.block),
  `block is ${JSON.stringify(malformed)}`,
);

// Every other tool is untouched by the approval rule.
const other = beforeTool(call("executor_call", { calls: [] }), api, context);
check("executor_call allowed", other === undefined, `hook returned ${JSON.stringify(other)}`);

// The wrap times the call, reports it, and keeps the original result.
const original = { output: [{ type: "text", text: "ok" }] };
const wrapped = extension.wraps[0].wrap({
  name: "executor_call",
  description: "fake",
  parameters: {},
  execute: async () => original,
});
const returned = await wrapped.execute({}, api, context);
check("result preserved", returned === original, `returned ${JSON.stringify(returned)}`);
check(
  "call reported",
  reports.length === 1 &&
    reports[0].name === "executor_call" &&
    Number.isFinite(reports[0].durationMs) &&
    reports[0].durationMs >= 0,
  `reports are ${JSON.stringify(reports)}`,
);

// A failing call is reported too, and its error reaches the caller.
const failure = new Error("executor refused");
const failing = extension.wraps[1].wrap({
  name: "executor_execute",
  description: "fake",
  parameters: {},
  execute: async () => {
    throw failure;
  },
});
let caught;
try {
  await failing.execute({}, api, context);
} catch (error) {
  caught = error;
}
check("error passed through", caught === failure, `caught ${String(caught)}`);
check(
  "failed call reported",
  reports.length === 2 &&
    reports[1].name === "executor_execute" &&
    Number.isFinite(reports[1].durationMs) &&
    reports[1].durationMs >= 0,
  `reports are ${JSON.stringify(reports)}`,
);

if (failures.length > 0) {
  console.error("executor-policy smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("executor-policy smoke passed");
process.exit(0);
