/**
 * Smoke test for the Executor v2 bridge (src/executor-mcp.ts).
 *
 * Run with: bun tests/executor-mcp.smoke.mjs
 *
 * With EXECUTOR_URL / EXECUTOR_TOKEN set it opens a real Executor MCP session
 * and exercises two read-only meta-tools through the pi tools: executor_skills
 * (list what is visible; connects no account, runs no code) and executor_search.
 *
 * Without those env vars it prints a clear "skipped" line and exits 0, so it is
 * safe to run in CI before live credentials exist. It never reads credentials
 * from anywhere else.
 */

const url = process.env.EXECUTOR_URL;
const token = process.env.EXECUTOR_TOKEN;

if (!url || !token) {
  console.log("skipped: EXECUTOR_URL/EXECUTOR_TOKEN not set");
  process.exit(0);
}

const { createExecutorMcp } = await import("../src/executor-mcp.ts");

const extension = createExecutorMcp({ url, token });
const tools = new Map((extension.tools ?? []).map((tool) => [tool.name, tool]));

const textOf = (result) =>
  (result.output ?? [])
    .map((item) => (item.type === "text" ? item.text : `[${item.type}]`))
    .join("\n");

const invoke = async (toolName, args) => {
  const tool = tools.get(toolName);
  if (!tool) {
    throw new Error(`tool ${toolName} is not registered on the extension`);
  }
  return tool.execute(args, {}, {});
};

const failures = [];

try {
  console.log(`executor-mcp smoke against ${url}`);

  const skills = await invoke("executor_skills", {});
  const skillsText = textOf(skills);
  if (skills.isError) {
    failures.push(`executor_skills returned an error:\n${skillsText}`);
  } else {
    console.log("\n[executor_skills ok]");
    console.log(skillsText.slice(0, 600));
  }

  const search = await invoke("executor_search", { query: "executor" });
  const searchText = textOf(search);
  if (search.isError) {
    failures.push(`executor_search returned an error:\n${searchText}`);
  } else {
    console.log("\n[executor_search ok]");
    console.log(searchText.slice(0, 600));
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}

if (failures.length > 0) {
  console.error("\nexecutor-mcp smoke FAILED:\n");
  for (const failure of failures) console.error(failure, "\n");
  process.exit(1);
}

console.log("\nexecutor-mcp smoke passed");
process.exit(0);
