/**
 * Smoke test for the Executor bridge's result rendering (src/executor-mcp.ts).
 *
 * Run with: bun tests/executor-mcp-render.smoke.mjs
 *
 * Drives `renderResult` with synthetic `CallToolResult` values shaped like the
 * ones live Executor returns, so the pause header, the pause detection for both
 * elicitation modes, the payload de-duplication, and which failure shapes count
 * as errors are all checked without credentials and without a skipped test.
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
    text.includes(
      "Open this link to approve: https://app.executor.sh/mcp/approve/apr_test_browser",
    ),
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

// A failed program is the one in-envelope failure only `execution.ok` records.
// Payloads below are the real envelopes, verbatim in shape.
{
  const parseError = {
    status: "completed",
    execution: {
      ok: false,
      error: { kind: "ParseError", message: "Unexpected token (2:5)" },
      toolCalls: [],
    },
  };
  const result = render(parseError, JSON.stringify(parseError));
  check("failed program", result.isError === true, "a failed program was not marked");
  check("failed program", !outputOf(result).includes("structuredContent:"), "not de-duplicated");
}

// A program that succeeded is not an error, whatever its return value looks like.
{
  const returned = { status: "completed", execution: { ok: true, value: 2, toolCalls: [] } };
  check(
    "program returned a value",
    render(returned, JSON.stringify(returned)).isError === false,
    "flagged",
  );
  const looksFailed = {
    status: "completed",
    execution: { ok: true, value: { ok: false }, toolCalls: [] },
  };
  check(
    "program returned {ok:false}",
    render(looksFailed, JSON.stringify(looksFailed)).isError === false,
    "a program's own return value was read as a failure",
  );
}

// A failed individual call keeps its own error in the payload rather than
// becoming a blanket error, because an array of calls can mix both.
{
  const unknownTool = {
    status: "completed",
    execution: {
      ok: true,
      value: {
        path: "tools.does-not-exist.whatever",
        ok: false,
        error: {
          kind: "UnknownTool",
          message: "No tool at tools.does-not-exist.whatever. Use search to find exact paths.",
        },
        matches: [],
      },
      toolCalls: [],
    },
  };
  const result = render(unknownTool, JSON.stringify(unknownTool));
  check("unknown tool path", result.isError === false, "marked the whole result as an error");
  check(
    "unknown tool path",
    outputOf(result).includes("Use search to find exact paths"),
    "lost the error",
  );
}

// A denied approval is the same shape, and the denial has to stay readable.
{
  const denied = {
    status: "completed",
    execution: {
      ok: true,
      value: {
        path: 'tools["akahu-accounts"].listAccounts',
        ok: false,
        error: { kind: "ToolFailure", message: "ApprovalDenied" },
      },
      toolCalls: [
        { name: 'tools["akahu-accounts"].listAccounts', outcome: "failure", durationMs: 1963 },
      ],
    },
  };
  const result = render(denied, JSON.stringify(denied));
  check("denied approval", outputOf(result).includes("ApprovalDenied"), "the denial was lost");
  check(
    "denied approval",
    result.isError === false,
    "a per-call denial was marked as a whole-result error",
  );
}

// An array of calls can mix a failure with a success, which is why a failed
// individual call must not become a blanket error.
{
  const mixed = {
    status: "completed",
    execution: {
      ok: true,
      value: [
        {
          path: "tools.does-not-exist.whatever",
          ok: false,
          error: { kind: "UnknownTool", message: "No tool at tools.does-not-exist.whatever." },
          matches: [],
        },
        { path: "tools.executor.context.get", ok: true, value: { slug: "isaac-mackle" } },
      ],
      toolCalls: [{ name: "tools.executor.context.get", outcome: "success", durationMs: 1232 }],
    },
  };
  const result = render(mixed, JSON.stringify(mixed));
  const text = outputOf(result);
  check("array, one failed", result.isError === false, "one failed call marked every call failed");
  check("array, one failed", text.includes("isaac-mackle"), "lost the successful call");
  check(
    "array, one failed",
    text.includes("No tool at tools.does-not-exist.whatever"),
    "lost the failed call",
  );
}

// describe reports an unknown path as a success carrying `missing`, not as an
// error, and it must not be read as one.
{
  const missing = {
    items: [],
    namespaces: [],
    missing: [{ path: "tools.does-not-exist.whatever", matches: [] }],
  };
  const result = render(missing, JSON.stringify(missing));
  check(
    "describe missing path",
    result.isError === false,
    "a not-found answer was marked an error",
  );
}

// Executor's own isError flag passes through untouched.
{
  const result = render(
    undefined,
    "Invalid parameters for tool 'resume': Missing key at [\"response\"]",
    true,
  );
  check("isError passthrough", result.isError === true, "isError lost");
  check("isError passthrough", outputOf(result).includes("Missing key"), "message lost");
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
