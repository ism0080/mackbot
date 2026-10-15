/**
 * Smoke test for how the bridge obtains its MCP connection (src/executor-mcp.ts).
 *
 * Run with: bun tests/executor-mcp-connection.smoke.mjs
 *
 * Injects a connector that counts connections, so the sharing policy can be
 * checked without a live Executor and without credentials. The policy is worth
 * pinning because the read-only tools sharing a connection is a latency choice,
 * while the unsafe tools keeping a fresh one is a safety property.
 */
const { createExecutorMcp } = await import("../src/executor-mcp.ts");

const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}: ${detail}`);
};

const completed = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});

const makeConnector = () => {
  const state = { opened: 0, closed: 0, failNextCall: false };
  const connect = async () => {
    state.opened += 1;
    const connection = state.opened;
    return {
      request: async (message) => {
        if (state.failNextCall) {
          state.failNextCall = false;
          throw new Error("connection went away");
        }
        return completed({ status: "completed", op: message.params.name, connection });
      },
      close: async () => {
        state.closed += 1;
      },
    };
  };
  return { connect, state };
};

const toolsOf = (connector) => {
  const extension = createExecutorMcp(
    { url: "https://example.invalid/mcp", token: "test" },
    { connect: connector.connect },
  );
  return new Map((extension.tools ?? []).map((tool) => [tool.name, tool]));
};

const search = (tools, query) => tools.get("executor_search").execute({ query }, {}, {});
const call = (tools, path) =>
  tools.get("executor_call").execute({ calls: { path, input: {} } }, {}, {});

// The read-only tools share, so a discovery round trip pays one handshake.
{
  const { connect, state } = makeConnector();
  const tools = toolsOf({ connect });
  await search(tools, "a");
  await search(tools, "b");
  check("safe tools share a connection", state.opened === 1, `opened ${state.opened}`);
  check("shared connection stays open", state.closed === 0, `closed ${state.closed}`);
}

// Sharing spans the read-only tools, not just one of them.
{
  const { connect, state } = makeConnector();
  const tools = toolsOf({ connect });
  await search(tools, "a");
  await tools.get("executor_describe").execute({ paths: ["tools.x.y"] }, {}, {});
  await tools.get("executor_skills").execute({ app: "x" }, {}, {});
  check("all read-only tools share", state.opened === 1, `opened ${state.opened}`);
}

// A tool that can change the outside world never reuses a connection, so a
// stale one cannot make its outcome ambiguous.
{
  const { connect, state } = makeConnector();
  const tools = toolsOf({ connect });
  await call(tools, "tools.x.y");
  await call(tools, "tools.x.z");
  check("unsafe tools never share", state.opened === 2, `opened ${state.opened}`);
  check("unsafe connections are closed", state.closed === 2, `closed ${state.closed}`);
}

// An unsafe call must not consume or disturb the shared connection.
{
  const { connect, state } = makeConnector();
  const tools = toolsOf({ connect });
  await search(tools, "a");
  await call(tools, "tools.x.y");
  await search(tools, "b");
  check("unsafe call does not open a shared one", state.opened === 2, `opened ${state.opened}`);
  check("shared connection survives an unsafe call", state.closed === 1, `closed ${state.closed}`);
}

// A failed read-only call retires the connection and the next call reconnects.
{
  const { connect, state } = makeConnector();
  const tools = toolsOf({ connect });
  state.failNextCall = true;
  const first = await search(tools, "a");
  check("failed safe call is an error result", first.isError === true, "not marked as an error");
  check("failed connection is retired", state.closed === 1, `closed ${state.closed}`);
  const second = await search(tools, "b");
  check("next safe call reconnects", state.opened === 2, `opened ${state.opened}`);
  check("next safe call succeeds", second.isError !== true, "still failing");
}

// A connect that fails must not be cached, or the failure becomes permanent.
{
  let attempts = 0;
  const connect = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("cannot reach Executor");
    return { request: async () => completed({ status: "completed" }), close: async () => {} };
  };
  const tools = toolsOf({ connect });
  const first = await search(tools, "a");
  check("connect failure is an error result", first.isError === true, "not marked as an error");
  const second = await search(tools, "b");
  check("failed connect is not cached", attempts === 2, `attempted ${attempts} times`);
  check("second attempt succeeds", second.isError !== true, "still failing");
}

if (failures.length > 0) {
  console.error("executor-mcp-connection smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("executor-mcp-connection smoke passed");
process.exit(0);
