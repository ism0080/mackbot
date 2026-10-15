/**
 * executor-mcp — the Executor v2 bridge for mackbot.
 *
 * This module turns Executor's fixed set of six MCP meta-tools into six pi tools,
 * so a bot reaches every Executor app through one stable tool surface. The tool
 * list never grows with the number of apps, so prompt/context cost stays fixed.
 *
 * Pi tools and the Executor MCP tool each wraps (Executor MCP tool names are the
 * bare names, `search`/`describe`/`call`/`execute`/`skills`/`resume`; the
 * `executor.*` spelling in the plan is just our label for them):
 *
 *   executor_search   -> search    replay: safe    discover tools by words/namespace
 *   executor_describe -> describe  replay: safe    full signatures before calling
 *   executor_call     -> call      replay: unsafe  one/few direct {path, input} calls
 *   executor_execute  -> execute   replay: unsafe  a JS program for composition/filtering
 *   executor_skills   -> skills    replay: safe    read an app's instructions first
 *   executor_resume   -> resume    replay: unsafe  answer a paused approval/input request
 *
 * Plus one prompt section, `executor-protocol`, that teaches the model the
 * search -> describe -> call / execute protocol, how approvals pause and resume,
 * and that interrupted unsafe calls must never be blindly re-run.
 *
 * Public API (what `src/index.ts` imports):
 *
 *   import { createExecutorMcp } from "./executor-mcp.ts";
 *   const extension = createExecutorMcp({ url: env.EXECUTOR_URL, token: env.EXECUTOR_TOKEN });
 *
 * `url` is the org/connection MCP URL. Its `elicitation_mode` decides how
 * approvals arrive: the bare URL uses `model`, where the paused result carries a
 * `requestId` for the model to put to the user; `?elicitation_mode=browser`
 * additionally carries an `approvalUrl`, which is a link signed for the org
 * connection and therefore one to relay rather than to log or store.
 * `token` is the org-scoped PAT sent as `Authorization: Bearer <token>`.
 * Register the returned `Extension` in the harness registry (or select it on the
 * conversation's agent). Optional `timeoutMs` (tool calls, default 600_000) and
 * `connectTimeoutMs` (handshake, default 60_000) override the defaults.
 *
 * Every call opens its own MCP client/transport and closes it again, so an
 * evicted or restarted Executor Durable Object never leaves a stale cached
 * connection behind ("eviction-proof").
 *
 * MCP mechanics deliberately match the pinned @modelcontextprotocol/sdk@1.32.1:
 * the transport is StreamableHTTPClientTransport with bearer auth in
 * `requestInit.headers`, and tool calls use `client.request(..., { timeout })`.
 * The SDK's own per-request timeout default is 60s (DEFAULT_REQUEST_TIMEOUT_MSEC);
 * we raise it well past Executor's 5-minute `execute` ceiling because time spent
 * paused for human approval ticks the client clock even though it does not count
 * server-side.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolRequest, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "@earendil-works/pi-ai";
import type { TextContent } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { Extension, ToolExecutionResult } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Tool-call timeout: well above the SDK's 60s default and Executor's 5-min `execute`. */
const DEFAULT_TIMEOUT_MS = 600_000;
/** MCP handshake timeout; a connection should come up quickly or fail fast. */
const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;
const CLIENT_NAME = "mackbot";
const CLIENT_VERSION = "0.1.0";

export type ExecutorMcpConfig = {
    readonly url: string;
    readonly token: string;
    readonly timeoutMs?: number;
    readonly connectTimeoutMs?: number;
};

type ResolvedConfig = {
  readonly url: string;
  readonly token: string;
  readonly timeoutMs: number;
  readonly connectTimeoutMs: number;
};

/**
 * Arguments sent as an MCP tool call's `arguments`. Derived from the SDK's own
 * request type so the dictionary shape stays at the protocol boundary instead of
 * being re-declared here.
 */
type McpToolArguments = NonNullable<CallToolRequest["params"]["arguments"]>;

const resolveConfig = (config: ExecutorMcpConfig): ResolvedConfig => ({
  url: config.url,
  token: config.token,
  timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  connectTimeoutMs: config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
});

const connect = (config: ResolvedConfig): Effect.Effect<Client, unknown> =>
  Effect.tryPromise({
    try: async () => {
      const transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: {
          headers: { Authorization: `Bearer ${config.token}` },
        },
      });
      const client = new Client(
        { name: CLIENT_NAME, version: CLIENT_VERSION },
        { capabilities: {} },
      );
      await client.connect(transport, { timeout: config.connectTimeoutMs });
      return client;
    },
    catch: (cause) => cause,
  });

const closeClient = (client: Client): Effect.Effect<void> =>
  Effect.tryPromise(() => client.close()).pipe(Effect.orElseSucceed(() => undefined));

const callMetaTool = (
  config: ResolvedConfig,
  name: string,
  args: McpToolArguments,
): Effect.Effect<CallToolResult, unknown> =>
  Effect.acquireUseRelease(
    connect(config),
    (client) =>
      Effect.tryPromise({
        try: () =>
          client.request(
            { method: "tools/call", params: { name, arguments: args } },
            CallToolResultSchema,
            { timeout: config.timeoutMs },
          ),
        catch: (cause) => cause,
      }),
    (client) => closeClient(client),
  );

const textItem = (text: string): TextContent => ({ type: "text", text });

const errorResult = (text: string): ToolExecutionResult => ({
  output: [textItem(text)],
  isError: true,
});

const describeError = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const renderContent = (content: CallToolResult["content"]): string => {
  const parts: string[] = [];
  for (const item of content) {
    if (item.type === "text") {
      parts.push(item.text);
    } else {
      parts.push(`[${item.type} content] ${JSON.stringify(item)}`);
    }
  }
  return parts.join("\n");
};

/** Executor's pause envelope (and the pre-`requestId` `executionId` variant). */
export const APPROVAL_URL_PATTERN = /https?:\/\/[^\s"'<>]+/u;
/** The `approvalUrl` value itself, preferred over the first URL anywhere in the text. */
export const APPROVAL_URL_VALUE_PATTERN = /"approvalUrl"\s*:\s*"([^"]+)"/u;
export const APPROVAL_KEY_PATTERN = /"approvalUrl"\s*:/u;
export const APPROVAL_TEXT_PATTERN =
  /(approval (?:is )?required|user_approval_required|approve (?:the|this))/iu;
/**
 * The `status` a paused envelope carries. Both elicitation modes set it, and it
 * is the only pause signal model mode has, because that mode returns no
 * `approvalUrl` to match on.
 */
export const APPROVAL_STATUS_PATTERN = /"status"\s*:\s*"approval-required"/u;
const REQUEST_ID_PATTERN = /"(?:requestId|executionId)"\s*:\s*"([^"]+)"/u;

export const approvalNotice = (haystack: string): string => {
  const url =
    APPROVAL_URL_VALUE_PATTERN.exec(haystack)?.[1] ?? APPROVAL_URL_PATTERN.exec(haystack)?.[0];
  const requestId = REQUEST_ID_PATTERN.exec(haystack)?.[1];
  const lines = ["APPROVAL REQUIRED — this call paused and needs the user to act."];
  if (url !== undefined) lines.push(`Open this link to approve: ${url}`);
  if (requestId !== undefined) {
    lines.push(`Then call executor_resume with requestId ${requestId}.`);
  } else {
    lines.push("Then call executor_resume with the requestId shown below.");
  }
  return lines.join("\n");
};

/** Whether a result body is a call paused for the user. */
export const looksPaused = (haystack: string): boolean =>
  APPROVAL_STATUS_PATTERN.test(haystack) ||
  APPROVAL_KEY_PATTERN.test(haystack) ||
  (APPROVAL_TEXT_PATTERN.test(haystack) && APPROVAL_URL_PATTERN.test(haystack));

export const maybeApprovalNotice = (haystack: string): string | null =>
  looksPaused(haystack) ? approvalNotice(haystack) : null;

const JsonFromText = Schema.fromJsonString(Schema.Unknown);

/** Whether the text section already is the structured payload, serialized. */
const repeatsStructured = (text: string, structured: string): boolean => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const parsed = Option.getOrElse(
    Schema.decodeUnknownOption(JsonFromText)(trimmed),
    () => undefined,
  );
  return parsed !== undefined && JSON.stringify(parsed) === structured;
};

const renderBody = (text: string, structured: string): string => {
  const parts: string[] = [];
  if (text.length > 0) parts.push(text);
  if (structured.length > 0) parts.push(`structuredContent:\n${structured}`);
  return parts.length > 0 ? parts.join("\n\n") : "(Executor returned no content)";
};

/**
 * Map an MCP `CallToolResult` onto a pi tool result. A paused approval gets a
 * prominent header; failures come back as `isError` results so the model can
 * react instead of the harness throwing. Exported so the rendering can be
 * checked against synthetic envelopes without a live Executor.
 */
export const renderResult = (result: CallToolResult): ToolExecutionResult => {
  const text = renderContent(result.content);
  const structuredContent = result.structuredContent;
  const compact = structuredContent === undefined ? "" : JSON.stringify(structuredContent);
  // Executor answers most tools with the same payload in `content` and in
  // `structuredContent`. Rendering both charges the model twice for one result,
  // so the structured section is dropped when it only repeats the text. A text
  // section that is not that same JSON still keeps it.
  const structured =
    structuredContent === undefined || repeatsStructured(text, compact)
      ? ""
      : JSON.stringify(structuredContent, null, 2);
  const haystack = structured.length > 0 ? `${text}\n${structured}` : text;
  const body = renderBody(text, structured);
  const output = looksPaused(haystack) ? `${approvalNotice(haystack)}\n\n${body}` : body;
  // Executor already sets `isError` on real tool failures; this backstop only
  // fires on an explicit error status, so an unrelated `errorCode` key cannot
  // flip a successful result into an error. It reads the whole structured
  // payload even when that payload was not rendered, so dropping a repeat cannot
  // hide one.
  const structuredFailure = /"status"\s*:\s*"error"/u.test(compact);
  return {
    output: [textItem(output)],
    isError: result.isError === true || structuredFailure,
  };
};

const runMetaTool = (
  config: ResolvedConfig,
  name: string,
  args: McpToolArguments,
): Effect.Effect<ToolExecutionResult> =>
  callMetaTool(config, name, args).pipe(
    Effect.match({
      onSuccess: renderResult,
      onFailure: (cause) =>
        errorResult(`Executor MCP call failed (${name}): ${describeError(cause)}`),
    }),
  );

const executorProtocol = [
  "All real tools live behind Executor; you reach them only through the executor_* tools.",
  "The list is fixed — search, describe, call, execute, skills, resume — and does not grow with apps.",
  "",
  "Protocol:",
  "1. Discover with executor_search. Pass words (query) or an app namespace. Each result",
  '   carries an exact callable path, and a slug with a hyphen appears as tools["<app>"].<tool>,',
  "   so use the path exactly as it comes back. Executor picks which linked account a call",
  "   uses, so there is no account or profile segment to add.",
  "2. Read the full signature with executor_describe({ paths }) before the first call to an",
  "   unfamiliar tool.",
  "3. Call directly with executor_call({ calls }) for one or a few tools: { path, input }, or",
  "   an array, which runs concurrently.",
  "4. Prefer executor_execute({ code }) when one result feeds the next or a large result",
  "   should be reduced before it reaches you. The program calls app tools as async",
  "   functions and returns only what you need.",
  "5. Read an app's instructions with executor_skills({ app }) before the first real use of",
  "   that app.",
  "",
  "Approvals: an approval-gated call pauses. Say what is waiting, and only after the user",
  "answers call executor_resume with the requestId from the paused result, plus the answer",
  "when the request asks for input. If that paused result carries an approvalUrl, relay the",
  "link in the channel you are talking to them on and resume once they have acted. Never",
  "invent an approval.",
  "",
  "Interruptions and restarts: after an eviction or restart an interrupted unsafe call",
  'surfaces as "interrupted" — decide what to do; never blindly re-run it. A lost Executor',
  "session cannot be resumed and must not be re-run automatically, because earlier calls may",
  "already have taken effect.",
].join("\n");

const executorProtocolSection = section("executor-protocol", () => executorProtocol);

const searchTool = (config: ResolvedConfig) =>
  defineTool({
    name: "executor_search",
    description:
      "Discover Executor tools by words (query) or by an app namespace. Returns each tool's exact callable path and input type. Read-only and side-effect free.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Keywords describing the tool or task." })),
      namespace: Type.Optional(
        Type.String({ description: "App slug/namespace to list instead of searching." }),
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum results to return." })),
      offset: Type.Optional(Type.Number({ description: "Number of results to skip." })),
    }),
    replay: "safe",
    execute: (args) => Effect.runPromise(runMetaTool(config, "search", args)),
  });

const describeTool = (config: ResolvedConfig) =>
  defineTool({
    name: "executor_describe",
    description:
      "Return the full description and signature of Executor tools at exact paths returned by executor_search. Accepts at most 20 paths per call, so describe the few tools a task actually needs. Call before invoking an unfamiliar tool.",
    parameters: Type.Object({
      paths: Type.Array(Type.String(), {
        description: "Exact tool paths from executor_search, at most 20.",
        maxItems: 20,
      }),
    }),
    replay: "safe",
    execute: (args) => Effect.runPromise(runMetaTool(config, "describe", args)),
  });

const callTool = (config: ResolvedConfig) =>
  defineTool({
    name: "executor_call",
    description:
      "Call Executor app tools directly by exact path. Pass one { path, input } as `calls`, or an array of independent calls, which run concurrently. Use executor_execute instead when one result feeds another call or a large result must be reduced.",
    parameters: Type.Object({
      calls: Type.Union(
        [
          Type.Object({
            path: Type.String({ description: "Exact tool path, e.g. tools.github.listIssues." }),
            input: Type.Optional(
              Type.Any({ description: "Tool input matching the path's schema." }),
            ),
          }),
          Type.Array(
            Type.Object({
              path: Type.String({ description: "Exact tool path." }),
              input: Type.Optional(Type.Any({ description: "Tool input." })),
            }),
          ),
        ],
        { description: "One call, or an array of independent calls." },
      ),
    }),
    replay: "unsafe",
    execute: (args) => Effect.runPromise(runMetaTool(config, "call", args)),
  });

const executeTool = (config: ResolvedConfig) =>
  defineTool({
    name: "executor_execute",
    description:
      "Run a short JavaScript program over Executor apps. App tools are async functions; return only what you need. Use when one result feeds another call or a large result should be reduced before it reaches you. Executor caps a program at 65536 characters, 100 tool calls, 100000 bytes of output, and 5 minutes, not counting time spent waiting for an approval.",
    parameters: Type.Object({
      code: Type.String({
        description: "JavaScript program source, at most 65536 characters.",
        maxLength: 65_536,
      }),
    }),
    replay: "unsafe",
    execute: (args) => Effect.runPromise(runMetaTool(config, "execute", args)),
  });

const skillsTool = (config: ResolvedConfig) =>
  defineTool({
    name: "executor_skills",
    description:
      "Read the instructions an Executor app ships. Call with no arguments to list what is visible, or with an app to read that app's skills. Read-only; connects no account and runs no code.",
    parameters: Type.Object({
      app: Type.Optional(Type.String({ description: "App slug, such as akahu-accounts." })),
      name: Type.Optional(Type.String({ description: "Skill name within the app." })),
      file: Type.Optional(Type.String({ description: "A skill file to read." })),
      version: Type.Optional(
        Type.String({
          description:
            "Version to read instead of the app's active one, in the dpl_... form from a skills listing or an invocation envelope.",
        }),
      ),
      revision: Type.Optional(
        Type.String({ description: "Skill revision identifier, a 64-character hex digest." }),
      ),
      accounts: Type.Optional(
        Type.Any({ description: "Accounts to describe, when the skill needs them." }),
      ),
    }),
    replay: "safe",
    execute: (args) => Effect.runPromise(runMetaTool(config, "skills", args)),
  });

const resumeResponse = Type.Object(
  {
    action: Type.Union([Type.Literal("accept"), Type.Literal("decline"), Type.Literal("cancel")], {
      description: "How to answer the paused request.",
    }),
    content: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Array(Type.String())]),
      ),
    ),
  },
  { additionalProperties: true, description: "The answer to a paused request." },
);

const resumeTool = (config: ResolvedConfig) =>
  defineTool({
    name: "executor_resume",
    description:
      "Collect the result of a call that paused for an approval or for input. Pass the requestId from the paused result; add `response` with an action (and form content) when the paused request asks you to decide. This call is what authorizes the effect.",
    parameters: Type.Object(
      {
        requestId: Type.String({
          description: "The requestId from the paused executor result.",
        }),
        response: Type.Optional(resumeResponse),
      },
      { additionalProperties: true },
    ),
    replay: "unsafe",
    execute: (args) => Effect.runPromise(runMetaTool(config, "resume", args)),
  });

/**
 * Build the Executor v2 bridge extension: six pi tools plus the
 * `executor-protocol` prompt section. Give the result to the harness registry
 * (`registry.install(...)`) or select it on a conversation's agent.
 */
export function createExecutorMcp(config: ExecutorMcpConfig): Extension {
  const resolved = resolveConfig(config);
  return defineExtension({
    name: "executor-mcp",
    tools: [
      searchTool(resolved),
      describeTool(resolved),
      callTool(resolved),
      executeTool(resolved),
      skillsTool(resolved),
      resumeTool(resolved),
    ],
    sections: [executorProtocolSection],
  });
}
