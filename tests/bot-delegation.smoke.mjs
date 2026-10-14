/**
 * Smoke test for the bot-delegation extension (src/bot-delegation.ts).
 *
 * Run with: bun tests/bot-delegation.smoke.mjs
 *
 * Pure-logic smoke: exercises the unknown-target and self-delegation guards
 * without a live Durable Object, using a fake env.Bot. No credentials needed.
 */
const { createBotDelegation } = await import("../src/bot-delegation.ts");

const fakeEnv = {
  Bot: {
    getByName: (_name) => ({
      submit: async () => ({ operationId: "x", accepted: true }),
      wait: async () => ({ status: "done", text: "ok" }),
    }),
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

// Unknown target -> error, mentions declared bots.
try {
  const r = await tool.execute({ target: "nope", task: "hi" }, {}, {});
  if (!r.isError) failures.push("unknown target did not set isError");
  const t = textOf(r);
  if (!t.includes('unknown bot "nope"')) failures.push(`unknown target text off: ${t}`);
  if (!t.includes("hermes")) failures.push("unknown target missing roster");
} catch (error) {
  failures.push(`unknown target threw: ${error?.message ?? error}`);
}

// Self-delegation -> error.
try {
  const r = await tool.execute({ target: "hermes", task: "hi" }, {}, {});
  if (!r.isError) failures.push("self delegation did not set isError");
  const t = textOf(r);
  if (!t.includes("cannot delegate to itself")) failures.push(`self text off: ${t}`);
} catch (error) {
  failures.push(`self delegation threw: ${error?.message ?? error}`);
}

// Missing required args should surface as a throw from the tool? The schema is
// declared; pi enforces. We simply ensure the tool object exists.

if (failures.length > 0) {
  console.error("bot-delegation smoke FAILED:");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}
console.log("bot-delegation smoke passed");
process.exit(0);