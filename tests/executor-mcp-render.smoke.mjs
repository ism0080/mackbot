/**
 * Smoke test for the Executor bridge's result rendering (src/executor-mcp.ts).
 *
 * Run with: bun tests/executor-mcp-render.smoke.mjs
 *
 * Drives `renderResult` with synthetic `CallToolResult` values shaped like the
 * ones live Executor returns, so the pause header, the pause detection for both
 * elicitation modes, and the payload de-duplication are all checked without
 * credentials and without a skipped test.
 */
const { renderResult } = await import("../src/executor-mcp.ts");

const failures = [];

const render = (structuredContent, text, isError) => {
  const result = { content: text === undefined ? [] : [{ type: "text", text }] };
  if (structuredContent !== undefined) result.structuredContent = structuredContent;
  if (isError !== undefined) result.isError = isError;
  return renderResult(result);
};

const outputOf = (result) =>
  (result.output ?? [])
    .map((item) => (item.type === "text" ? item.text : `<${item.type}>`))
    .join("\n");

const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}: ${detail}`);
};

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

// A pause as browser mode reports it, which is the mode that adds a signed link.
const browserPause = {
  status: "approval-required",
  requestId: "apr_test_browser",
  invocation: { tool: "listAccounts", kind: "query", input: {} },
  approvalUrl: "https://app.executor.sh/mcp/approve/apr_test_browser?sessionId=s1",
};
{
  const result = render(browserPause, JSON.stringify(browserPause));
  const text = outputOf(result);
  check("browser pause", text.startsWith("APPROVAL REQUIRED"), "no header");
  check(
    "browser pause",
    text.includes("Open this link to approve: https://app.executor.sh/mcp/approve/apr_test_browser"),
    "link not relayed",
  );
  check(
    "browser pause",
    text.includes("executor_resume with requestId apr_test_browser"),
    "requestId not named",
  );
  check("browser pause", result.isError === false, "marked as an error");
}

// A pause as model mode reports it. No approvalUrl exists in this mode, so the
// `status` field is the only thing that can mark it.
{
  const modelPause = {
    status: "approval-required",
    requestId: "apr_test_model",
    invocation: { tool: "listAccounts", kind: "query", input: {} },
  };
  const result = render(modelPause, JSON.stringify(modelPause));
  const text = outputOf(result);
  check("model pause", text.startsWith("APPROVAL REQUIRED"), "no header");
  check(
    "model pause",
    text.includes("executor_resume with requestId apr_test_model"),
    "requestId not named",
  );
  check("model pause", !text.includes("Open this link"), "invented a link");
  check("model pause", result.isError === false, "marked as an error");
}

// A settle result, which is where the two sections repeat each other.
const settled = {
  status: "completed",
  execution: {
    ok: true,
    value: { accounts: [{ name: "Buffer", maskedAccountNumber: "****8213" }] },
  },
};
{
  const compact = JSON.stringify(settled);
  const result = render(settled, compact);
  const text = outputOf(result);
  check("settle de-dupes", !text.includes("structuredContent:"), "kept the repeat");
  check("settle de-dupes", text === compact, `payload changed: ${text.slice(0, 80)}`);
  check(
    "settle de-dupes",
    occurrences(text, "****8213") === 1,
    `payload appears ${occurrences(text, "****8213")} times`,
  );
  check("settle de-dupes", !text.includes("APPROVAL REQUIRED"), "false approval header");
}

// A text section that says something else keeps the structured section.
{
  const result = render({ accounts: [{ name: "Buffer" }] }, "Five accounts, listed below.");
  const text = outputOf(result);
  check("different sections", text.includes("Five accounts, listed below."), "lost the text");
  check("different sections", text.includes("structuredContent:"), "dropped the structured data");
  check("different sections", text.includes('"name": "Buffer"'), "structured not pretty-printed");
}

// A non-JSON text section is prose, so it cannot be a repeat of the payload.
{
  const result = render({ accounts: [] }, "no accounts found");
  const text = outputOf(result);
  check("prose text", text.includes("no accounts found"), "lost the prose");
  check("prose text", text.includes("structuredContent:"), "dropped the structured data");
}

// An error status has to survive de-duplication, since the backstop reads the
// structured payload to decide `isError`.
{
  const errorPayload = { status: "error", message: "Tool input did not match its schema." };
  const result = render(errorPayload, JSON.stringify(errorPayload));
  check("error status", result.isError === true, "error status was hidden");
  check("error status", !outputOf(result).includes("structuredContent:"), "not de-duplicated");
}

// Executor's own isError flag passes through untouched.
{
  const result = render(undefined, "Executor MCP call failed (call): boom", true);
  check("isError passthrough", result.isError === true, "isError lost");
  check("isError passthrough", outputOf(result).includes("boom"), "message lost");
}

// Nothing at all still says so.
{
  const result = render(undefined, undefined);
  check("empty", outputOf(result) === "(Executor returned no content)", "wrong placeholder");
}

if (failures.length > 0) {
  console.error("executor-mcp-render smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("executor-mcp-render smoke passed");
process.exit(0);
