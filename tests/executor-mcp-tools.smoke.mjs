/**
 * Smoke test for the tool surface mackbot offers the model (src/executor-mcp.ts).
 *
 * Run with: bun tests/executor-mcp-tools.smoke.mjs
 *
 * The declared parameters and the protocol section are the contract Executor and
 * the model both see, so a bound that disagrees with Executor's, or a path shape
 * Executor no longer has, is a defect here. No credentials needed.
 */
const { createExecutorMcp } = await import("../src/executor-mcp.ts");

const extension = createExecutorMcp({ url: "https://example.invalid/mcp", token: "x" });
const tools = new Map((extension.tools ?? []).map((tool) => [tool.name, tool]));
const properties = (name) => tools.get(name)?.parameters?.properties ?? {};
const protocolSection = (extension.sections ?? []).find(
  (candidate) => candidate.key === "executor-protocol",
);
const protocol = protocolSection === undefined ? "" : protocolSection.render({});

const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}: ${detail}`);
};

// The six meta-tools, and which of them can change the outside world.
check("tool count", tools.size === 6, `found ${tools.size} tools: ${[...tools.keys()].join(", ")}`);
for (const [name, replay] of [
  ["executor_search", "safe"],
  ["executor_describe", "safe"],
  ["executor_skills", "safe"],
  ["executor_call", "unsafe"],
  ["executor_execute", "unsafe"],
  ["executor_resume", "unsafe"],
]) {
  check(name, tools.get(name)?.replay === replay, `replay is ${tools.get(name)?.replay}`);
}

// Executor rejects a describe of more than 20 paths, so the declared bound has
// to match it or the model gets a validation error instead of signatures.
check(
  "describe paths bound",
  properties("executor_describe").paths?.maxItems === 20,
  `maxItems is ${properties("executor_describe").paths?.maxItems}`,
);

// Executor caps program source at 65536 characters.
check(
  "execute code bound",
  properties("executor_execute").code?.maxLength === 65_536,
  `maxLength is ${properties("executor_execute").code?.maxLength}`,
);

// Executor renamed this parameter. Unknown parameters are ignored rather than
// rejected, so sending the old name silently reads the active version instead.
check(
  "skills version",
  properties("executor_skills").version !== undefined,
  "no version parameter",
);
check(
  "skills deployment",
  properties("executor_skills").deployment === undefined,
  "stale deployment parameter still declared",
);

// Account-backed calls carry no profile segment. Executor resolves the account
// from what is linked to the app, and no tool path in the org contains one.
check(
  "protocol has no profile path",
  !protocol.includes("profiles["),
  "protocol still teaches a profile path segment",
);
check(
  "protocol has no profile id",
  !protocol.includes("profile-id"),
  "protocol still asks for a profile id",
);

// Hyphenated slugs come back in bracket form, which the protocol should say.
check(
  "protocol shows bracket form",
  protocol.includes('tools["'),
  "protocol never shows tools[\"<app>\"]",
);

if (failures.length > 0) {
  console.error("executor-mcp-tools smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("executor-mcp-tools smoke passed");
process.exit(0);
