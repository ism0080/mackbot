/**
 * Smoke test for the bot-delegation extension (src/bot-delegation.ts).
 *
 * Run with: bun tests/bot-delegation.smoke.mjs
 *
 * Pure-logic smoke: exercises the unknown-target and self-delegation guards
 * without a live Durable Object, using a fake env.Bot and a fake env.Registry.
 * No credentials needed.
 */
const { createBotDelegation } = await import("../src/bot-delegation.ts");

const ROSTER = {
  hermes: {
    model: "deepseek-v4-pro",
    thinkingLevel: "high",
    systemPrompt: "You are Hermes.",
    delegatesTo: ["scribe"],
  },
  scribe: { model: "longcat-2.5-preview-free", systemPrompt: "You are Scribe." },
};

const fakeEnv = {
  Bot: {
    getByName: (_name) => ({
      submit: async () => ({ operationId: "x", accepted: true }),
      wait: async () => ({ status: "done", text: "ok" }),
    }),
  },
  Registry: {
    getByName: () => ({ roster: async () => ({ ...ROSTER }) }),
  },
};

const extension = createBotDelegation({ env: fakeEnv, sourceBotId: "hermes" });
const tools = new Map((extension.tools ?? []).map((tool) => [tool.name, tool]));
const tool = tools.get("delegate_to_bot");
if (!tool) {
  console.error("delegate_to_bot not registered");
  process.exit(1);
}

const textOf = (result) =>
  (result.output ?? [])
    .map((item) => (item.type === "text" ? item.text : `[${item.type}]`))
    .join("\n");

const failures = [];

try {
  const r = await tool.execute({ target: "nope", task: "hi" }, {}, {});
  if (!r.isError) failures.push("unknown target did not set isError");
  const t = textOf(r);
  if (!t.includes('unknown bot "nope"')) failures.push(`unknown target text off: ${t}`);
  if (!t.includes("hermes")) failures.push("unknown target missing roster");
} catch (error) {
  failures.push(`unknown target threw: ${error?.message ?? error}`);
}

try {
  const r = await tool.execute({ target: "hermes", task: "hi" }, {}, {});
  if (!r.isError) failures.push("self delegation did not set isError");
  const t = textOf(r);
  if (!t.includes("cannot delegate to itself")) failures.push(`self text off: ${t}`);
} catch (error) {
  failures.push(`self delegation threw: ${error?.message ?? error}`);
}

try {
  const r = await tool.execute({ target: "scribe", task: "hi" }, {}, {});
  if (r.isError) failures.push(`allowlisted delegation errored: ${textOf(r)}`);
  const t = textOf(r);
  if (!t.includes("ok")) failures.push(`allowlisted delegation text off: ${t}`);
} catch (error) {
  failures.push(`allowlisted delegation threw: ${error?.message ?? error}`);
}

// The target bot observes exactly the id passed to `submit`, so a recording env
// is what proves which operation a retry actually joins.
const submitted = [];
const recordingEnv = {
  Bot: {
    getByName: (_name) => ({
      submit: async (_task, operationId) => {
        submitted.push(operationId);
        return { operationId, accepted: true };
      },
      wait: async () => ({ status: "timeout" }),
    }),
  },
  Registry: {
    getByName: () => ({ roster: async () => ({ ...ROSTER }) }),
  },
};

const recordingExtension = createBotDelegation({ env: recordingEnv, sourceBotId: "hermes" });
const recordingTool = new Map(
  (recordingExtension.tools ?? []).map((entry) => [entry.name, entry]),
).get("delegate_to_bot");

try {
  await recordingTool.execute({ target: "scribe", task: "hi", operationId: "abc" }, {}, {});
  await recordingTool.execute({ target: "scribe", task: "hi", operationId: "abc" }, {}, {});
  if (submitted[0] !== "delegate:hermes:abc") {
    failures.push(`caller id not namespaced: ${submitted[0]}`);
  }
  if (submitted[1] !== submitted[0]) {
    failures.push(`same caller id resubmitted differently: ${submitted[1]} vs ${submitted[0]}`);
  }
} catch (error) {
  failures.push(`caller id delegation threw: ${error?.message ?? error}`);
}

try {
  const timedOut = await recordingTool.execute(
    { target: "scribe", task: "hi", operationId: "retry-me" },
    {},
    {},
  );
  const match = /\(operationId ([^)]+)\)/.exec(textOf(timedOut));
  if (match === null) {
    failures.push(`timeout text missing operationId: ${textOf(timedOut)}`);
  } else {
    const returned = match[1];
    await recordingTool.execute({ target: "scribe", task: "hi", operationId: returned }, {}, {});
    const resubmitted = submitted[submitted.length - 1];
    if (resubmitted !== returned) {
      failures.push(`retry double-namespaced: ${resubmitted} vs ${returned}`);
    }
    if (returned !== "delegate:hermes:retry-me") {
      failures.push(`timeout returned an unexpected id: ${returned}`);
    }
  }
} catch (error) {
  failures.push(`retry with returned id threw: ${error?.message ?? error}`);
}

if (failures.length > 0) {
  console.error("bot-delegation smoke FAILED:");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}
console.log("bot-delegation smoke passed");
process.exit(0);
