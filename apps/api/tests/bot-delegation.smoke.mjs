/**
 * Smoke test for the bot-delegation extension (src/bot-delegation.ts).
 *
 * Run with: bun tests/bot-delegation.smoke.mjs
 *
 * Pure-logic smoke: exercises the roster guards, the task-derived request id,
 * the "report later" path, and the reporter task, without a live Durable
 * Object, using a fake env.Bot, a fake env.Registry, and a fake tool api.
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

/**
 * The tool api as far as this tool uses it: the call's durable task id, the
 * durable memo that keeps a replay from starting a second reporter, and task
 * creation. `created` records what the extension asked for.
 */
const fakeApi = ({ taskId = "1", created = [], memos = new Map() } = {}) => ({
  taskId,
  conversationId: 1,
  memo: async (name, ...rest) => {
    // `memo(name, context)` reads; `memo(name, candidate, context)` stores.
    if (rest.length === 1) return memos.get(name);
    const [candidate] = rest;
    if (!memos.has(name)) memos.set(name, candidate);
    return memos.get(name);
  },
  createTask: async (task, input, options) => {
    const id = String(created.length + 1);
    created.push({ id, kind: task.definition.name, input, options });
    return id;
  },
});

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
  const r = await tool.execute({ target: "nope", task: "hi" }, fakeApi(), {});
  if (!r.isError) failures.push("unknown target did not set isError");
  const t = textOf(r);
  if (!t.includes('unknown bot "nope"')) failures.push(`unknown target text off: ${t}`);
  if (!t.includes("hermes")) failures.push("unknown target missing roster");
} catch (error) {
  failures.push(`unknown target threw: ${error?.message ?? error}`);
}

try {
  const r = await tool.execute({ target: "hermes", task: "hi" }, fakeApi(), {});
  if (!r.isError) failures.push("self delegation did not set isError");
  const t = textOf(r);
  if (!t.includes("cannot delegate to itself")) failures.push(`self text off: ${t}`);
} catch (error) {
  failures.push(`self delegation threw: ${error?.message ?? error}`);
}

try {
  const r = await tool.execute({ target: "scribe", task: "hi" }, fakeApi(), {});
  if (r.isError) failures.push(`allowlisted delegation errored: ${textOf(r)}`);
  const t = textOf(r);
  if (!t.includes("ok")) failures.push(`allowlisted delegation text off: ${t}`);
} catch (error) {
  failures.push(`allowlisted delegation threw: ${error?.message ?? error}`);
}

// The target bot observes exactly the id passed to `submit`, so a recording env
// is what proves which operation a call actually names.
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

// ─── The request id derives from the call, not the model ────────────────────

try {
  // The same tool task replayed after a crash runs again with a fresh api, and
  // must name the same target operation; another task must not.
  await recordingTool.execute({ target: "scribe", task: "hi" }, fakeApi({ taskId: "77" }), {});
  await recordingTool.execute({ target: "scribe", task: "hi" }, fakeApi({ taskId: "77" }), {});
  await recordingTool.execute({ target: "scribe", task: "hi" }, fakeApi({ taskId: "78" }), {});
  if (submitted[0] !== "delegate:hermes:task:77") {
    failures.push(`request id not derived from the task: ${submitted[0]}`);
  }
  if (submitted[1] !== submitted[0]) {
    failures.push(`replay named a different operation: ${submitted[1]} vs ${submitted[0]}`);
  }
  if (submitted[2] === submitted[0]) {
    failures.push(`a different task reused the same operation: ${submitted[2]}`);
  }
} catch (error) {
  failures.push(`task-derived id delegation threw: ${error?.message ?? error}`);
}

// An explicit caller override is namespaced into its own segment, so it can
// never pass for the target's own http:/cron:/delegate: work.
try {
  const created = [];
  await recordingTool.execute(
    { target: "scribe", task: "hi", operationId: "http:sneaky" },
    fakeApi({ taskId: "79", created }),
    {},
  );
  if (submitted[3] !== "delegate:hermes:caller:http:sneaky") {
    failures.push(`caller override not namespaced: ${submitted[3]}`);
  }
} catch (error) {
  failures.push(`caller override delegation threw: ${error?.message ?? error}`);
}

// ─── Timeout reports later; it never asks the model to call again ────────────

try {
  const created = [];
  const r = await recordingTool.execute(
    { target: "scribe", task: "hi" },
    fakeApi({ taskId: "80", created }),
    {},
  );
  const t = textOf(r);
  if (r.isError) failures.push(`timeout reported an error: ${t}`);
  if (/call delegate_to_bot again|operationId/iu.test(t)) {
    failures.push(`timeout still teaches a retry protocol: ${t}`);
  }
  if (!/new message/u.test(t)) failures.push(`timeout does not say the answer arrives later: ${t}`);
  const reporter = created[0];
  if (reporter === undefined) {
    failures.push("timeout created no background reporter task");
  } else {
    if (reporter.kind !== "mackbot.delegation-reporter") {
      failures.push(`reporter has the wrong kind: ${reporter.kind}`);
    }
    if (reporter.options?.background !== true) failures.push("reporter is not a background task");
    if (reporter.options?.ownership?.kind !== "conversation") {
      failures.push(`reporter is not conversation-owned: ${JSON.stringify(reporter.options)}`);
    }
    if (reporter.input?.operationId !== "delegate:hermes:task:80") {
      failures.push(`reporter watches the wrong operation: ${reporter.input?.operationId}`);
    }
    if (reporter.input?.target !== "scribe") {
      failures.push(`reporter has the wrong target: ${reporter.input?.target}`);
    }
    if (reporter.input?.reportRequestId !== "delegate-report:hermes:task:80") {
      failures.push(`reporter has a non-stable request id: ${reporter.input?.reportRequestId}`);
    }
  }
} catch (error) {
  failures.push(`timeout delegation threw: ${error?.message ?? error}`);
}

// `wait=false` is the same deal: a normal result plus a reporter, no receipt to
// fetch by calling the tool again.
try {
  const created = [];
  const r = await recordingTool.execute(
    { target: "scribe", task: "hi", wait: false },
    fakeApi({ taskId: "81", created }),
    {},
  );
  const t = textOf(r);
  if (r.isError) failures.push(`wait=false reported an error: ${t}`);
  if (/call delegate_to_bot again|operationId/iu.test(t)) {
    failures.push(`wait=false still teaches a retry protocol: ${t}`);
  }
  if (created[0]?.kind !== "mackbot.delegation-reporter") {
    failures.push("wait=false created no background reporter task");
  }
} catch (error) {
  failures.push(`wait=false delegation threw: ${error?.message ?? error}`);
}

// A replay must not start a second reporter for the same call.
try {
  const created = [];
  const memos = new Map();
  const api = fakeApi({ taskId: "82", created, memos });
  await recordingTool.execute({ target: "scribe", task: "hi", wait: false }, api, {});
  await recordingTool.execute({ target: "scribe", task: "hi", wait: false }, api, {});
  if (created.length !== 1) {
    failures.push(`replay started ${created.length} reporters`);
  }
} catch (error) {
  failures.push(`replayed reporter threw: ${error?.message ?? error}`);
}

// ─── The reporter delivers the answer as a follow-up, once ───────────────────

const reporterTask = (recordingExtension.tasks ?? []).find(
  (task) => task.definition.name === "mackbot.delegation-reporter",
);
if (reporterTask === undefined) {
  failures.push("reporter task is not registered with the extension");
}

const reporterRuntime = (drafts) => {
  const commits = [];
  return {
    conversationId: 1,
    conversation: async (id) => ({
      id,
      submit: async (draft) => {
        drafts.push(draft);
        return { id: drafts.length };
      },
    }),
    commit: async (change) => {
      commits.push(await change());
    },
    commits,
  };
};

if (reporterTask !== undefined) {
  const phase = reporterTask.definition.phases.report;
  const input = {
    target: "scribe",
    operationId: "delegate:hermes:task:83",
    reportRequestId: "delegate-report:hermes:task:83",
  };
  const task = {
    input,
    state: { status: "running", checkpoint: { phase: "report", answer: "the answer" } },
  };
  try {
    const drafts = [];
    const runtime = reporterRuntime(drafts);
    await phase(task, runtime, {});
    const delivered = drafts[0];
    if (delivered === undefined) {
      failures.push("reporter delivered no message");
    } else {
      if (delivered.whenBusy !== "followUp") {
        failures.push(`report is not a follow-up: ${delivered.whenBusy}`);
      }
      if (delivered.content !== "the answer") {
        failures.push(`report carried the wrong content: ${delivered.content}`);
      }
      if (delivered.requestId !== "delegate-report:hermes:task:83") {
        failures.push(`report has a non-stable request id: ${delivered.requestId}`);
      }
    }
    const last = runtime.commits.at(-1);
    if (last?.status !== "terminal") failures.push("reporter did not commit terminal");

    // A restart re-runs the phase: the same request id means pi joins the first
    // report instead of posting a second one.
    const replayDrafts = [];
    await phase(task, reporterRuntime(replayDrafts), {});
    if (replayDrafts[0]?.requestId !== delivered?.requestId) {
      failures.push(
        `replayed report used a different request id: ${replayDrafts[0]?.requestId} vs ${delivered?.requestId}`,
      );
    }
  } catch (error) {
    failures.push(`reporter report phase threw: ${error?.message ?? error}`);
  }

  // The watch phase polls across timeouts and checkpoints the answer it got.
  try {
    const answers = [
      { status: "timeout" },
      { status: "timeout" },
      { status: "done", text: "late" },
    ];
    const watchingEnv = {
      Bot: {
        getByName: () => ({
          submit: async () => ({ operationId: "x", accepted: true }),
          wait: async () => answers.shift(),
        }),
      },
      Registry: { getByName: () => ({ roster: async () => ({ ...ROSTER }) }) },
    };
    const watching = createBotDelegation({ env: watchingEnv, sourceBotId: "hermes" });
    const watchingReporter = (watching.tasks ?? []).find(
      (entry) => entry.definition.name === "mackbot.delegation-reporter",
    );
    const watch = watchingReporter.definition.phases.watch;
    const polls = [0, 1, 2];
    for (const poll of polls) {
      const runtime = reporterRuntime([]);
      await watch(
        { input, state: { status: "running", checkpoint: { phase: "watch", polls: poll } } },
        runtime,
        {},
      );
      const committed = runtime.commits.at(-1);
      const expected = poll < 2 ? "watch" : "report";
      if (committed?.checkpoint?.phase !== expected) {
        failures.push(
          `watch poll ${poll} committed ${committed?.checkpoint?.phase}, wanted ${expected}`,
        );
      }
      if (expected === "report" && committed?.checkpoint?.answer !== "late") {
        failures.push(`watch reported the wrong answer: ${committed?.checkpoint?.answer}`);
      }
    }
  } catch (error) {
    failures.push(`reporter watch phase threw: ${error?.message ?? error}`);
  }
}

if (failures.length > 0) {
  console.error("bot-delegation smoke FAILED:");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}
console.log("bot-delegation smoke passed");
process.exit(0);
