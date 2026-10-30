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
 *   const extension = createExecutorMcp({ url: env.EXECUTOR_URL, token: env.EXECUTOR_TOKEN },
 *     { onPaused: (paused) => approvals.recordPaused(paused) });
 *
 * `onPaused` is how a paused call becomes durable: the bridge detects the pause
 * and hands over the requestId and the envelope, and the host records the row.
 * Only Executor's own envelope counts as a pause: a result's text carries what
 * the tool read, which anyone can write, so it is never searched for one.
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
 * The read-only tools share one MCP client across calls and the others open one
 * each and close it again. Opening per call is eviction-proof but pays a full
 * handshake on every tool call, measured at roughly 2.4s, which is most of a
 * discovery round trip. An unsafe tool keeps a fresh connection because a
 * connection gone stale fails at the transport layer, and from there a caller
 * cannot tell whether the effect it asked for already happened.
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
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describeCause } from "./errors.ts";
import { toJson, toPrettyJson } from "./json.ts";

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
export type McpToolArguments = NonNullable<CallToolRequest["params"]["arguments"]>;

const resolveConfig = (config: ExecutorMcpConfig): ResolvedConfig => ({
  url: config.url,
  token: config.token,
  timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  connectTimeoutMs: config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
});

/** Opens one MCP client for one connection. */
type Connector = (config: ResolvedConfig) => Promise<Client>;

/**
 * What a paused result carries, as {@link renderResult} found it: the id
 * `executor_resume` accepts, and the envelope it came from.
 */
export type PausedEnvelope = {
  readonly requestId: string;
  /**
   * Executor's pause payload: `structuredContent` when it sent one, else the
   * text section. It is the record of what the paused call wanted to do, so it
   * is what the approval row is extracted from — and it can carry an
   * `approvalUrl` signed for the org connection, so it is parsed, never stored.
   */
  readonly envelope: string;
};

/** A paused call, with the conversation it paused in. */
export type PausedCall = PausedEnvelope & {
  /** The pi conversation, so a decision can steer the same one. */
  readonly session: string;
};

/** Where a paused call is recorded. */
export type PausedSink = (paused: PausedCall) => void;

const openClient: Connector = async (config) => {
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: {
      headers: { Authorization: `Bearer ${config.token}` },
    },
  });
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} });
  await client.connect(transport, { timeout: config.connectTimeoutMs });
  return client;
};

const closeClient = (client: Client): Effect.Effect<void> =>
  Effect.tryPromise(() => client.close()).pipe(Effect.orElseSucceed(() => undefined));

/**
 * How a tool call reaches Executor. `open` gives one call a fresh client,
 * `acquireShared` hands out a client shared across calls, and `dropShared`
 * retires that one once it has failed so the next call opens another.
 */
type Bridge = {
  readonly config: ResolvedConfig;
  readonly open: () => Effect.Effect<Client, unknown>;
  readonly acquireShared: () => Effect.Effect<Client, unknown>;
  readonly dropShared: (client: Client) => Effect.Effect<void>;
};

const makeBridge = (config: ExecutorMcpConfig, connector: Connector): Bridge => {
  const resolved = resolveConfig(config);
  let shared: Promise<Client> | undefined;
  // The client `shared` resolved to, so a failure can tell whether the client
  // it saw is still the one being handed out.
  let sharedClient: Client | undefined;
  const connectShared = (): Promise<Client> => {
    const attempt: Promise<Client> = connector(resolved).then(
      (client) => {
        if (shared === attempt) sharedClient = client;
        return client;
      },
      (cause: unknown) => {
        // Let the next call try again instead of reusing a rejected promise.
        if (shared === attempt) shared = undefined;
        throw cause;
      },
    );
    return attempt;
  };
  return {
    config: resolved,
    open: () => Effect.tryPromise({ try: () => connector(resolved), catch: (cause) => cause }),
    acquireShared: () =>
      Effect.tryPromise({
        try: () => {
          shared ??= connectShared();
          return shared;
        },
        catch: (cause) => cause,
      }),
    dropShared: (client) =>
      Effect.sync(() => {
        // A call that failed on a client another call already replaced must not
        // retire the healthy one that replaced it.
        if (sharedClient === client) {
          shared = undefined;
          sharedClient = undefined;
        }
        void client.close().catch(() => undefined);
      }),
  };
};

const requestOnce = (
  client: Client,
  config: ResolvedConfig,
  name: string,
  args: McpToolArguments,
): Effect.Effect<CallToolResult, unknown> =>
  Effect.tryPromise({
    try: () =>
      client.request(
        { method: "tools/call", params: { name, arguments: args } },
        CallToolResultSchema,
        { timeout: config.timeoutMs },
      ),
    catch: (cause) => cause,
  });

const callMetaTool = (
  bridge: Bridge,
  name: string,
  args: McpToolArguments,
  shared: boolean,
): Effect.Effect<CallToolResult, unknown> =>
  shared
    ? Effect.flatMap(bridge.acquireShared(), (client) =>
        requestOnce(client, bridge.config, name, args).pipe(
          Effect.catch((cause) =>
            Effect.flatMap(bridge.dropShared(client), () => Effect.fail(cause)),
          ),
        ),
      )
    : Effect.acquireUseRelease(
        bridge.open(),
        (client) => requestOnce(client, bridge.config, name, args),
        (client) => closeClient(client),
      );

const textItem = (text: string): TextContent => ({ type: "text", text });

const errorResult = (text: string): ToolExecutionResult => ({
  output: [textItem(text)],
  isError: true,
});

/** The longest failure text the model is shown. */
const MAX_ERROR_CHARS = 500;

/**
 * A failure's words with every secret the bridge holds taken out. Transport
 * errors quote the URL they failed on, and EXECUTOR_URL names the org
 * connection, so the token, the configured URL, any other URL and any bearer
 * credential are replaced before the text goes anywhere.
 */
export const redactSecrets = (
  text: string,
  secrets: { readonly url: string; readonly token: string },
): string => {
  let redacted = text;
  for (const [secret, placeholder] of [
    [secrets.token, "[redacted]"],
    [secrets.url, "[executor-url]"],
  ] as const) {
    if (secret.length > 0) redacted = redacted.split(secret).join(placeholder);
  }
  return redacted
    .replace(/Bearer\s+[^\s"',]+/giu, "Bearer [redacted]")
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu, "[url]");
};

const renderContent = (content: CallToolResult["content"]): string => {
  const parts: string[] = [];
  for (const item of content) {
    if (item.type === "text") {
      parts.push(item.text);
    } else {
      parts.push(`[${item.type} content] ${toJson(item)}`);
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

const noticeOf = (url: string | undefined, requestId: string | undefined): string => {
  const lines = ["APPROVAL REQUIRED — this call paused and needs the user to act."];
  if (url !== undefined) lines.push(`Open this link to approve: ${url}`);
  if (requestId !== undefined) {
    lines.push(`Then call executor_resume with requestId ${requestId}.`);
  } else {
    lines.push("Then call executor_resume with the requestId shown below.");
  }
  return lines.join("\n");
};

export const approvalNotice = (haystack: string): string => {
  const url =
    APPROVAL_URL_VALUE_PATTERN.exec(haystack)?.[1] ?? APPROVAL_URL_PATTERN.exec(haystack)?.[0];
  const requestId = REQUEST_ID_PATTERN.exec(haystack)?.[1];
  return noticeOf(url, requestId);
};

/**
 * Whether free text reads like a paused call. This is a heuristic over prose,
 * for relaying another bot's answer; it never decides that an Executor result
 * paused, because a result's text can quote anything a tool read — an email
 * body, a web page — and {@link renderResult} only trusts Executor's own
 * envelope.
 */
export const looksPaused = (haystack: string): boolean =>
  APPROVAL_STATUS_PATTERN.test(haystack) ||
  APPROVAL_KEY_PATTERN.test(haystack) ||
  (APPROVAL_TEXT_PATTERN.test(haystack) && APPROVAL_URL_PATTERN.test(haystack));

export const maybeApprovalNotice = (haystack: string): string | null =>
  looksPaused(haystack) ? approvalNotice(haystack) : null;

/**
 * The statuses Executor's own pause envelope carries: `approval-required` from
 * the hosted endpoint, and the open-source host's `waiting_for_interaction` and
 * browser-mode `user_approval_required`.
 */
const PAUSE_STATUSES = ["approval-required", "waiting_for_interaction", "user_approval_required"];

/**
 * Executor's pause envelope: a top-level object whose own `status` says the
 * call paused, with the id `resume` takes. Executor puts a tool's data under
 * `result`, never at the top level, so a tool cannot forge this shape by what
 * it returns.
 */
const PauseEnvelopeSchema = Schema.Struct({
  status: Schema.Literals(PAUSE_STATUSES),
  requestId: Schema.optional(Schema.String),
  executionId: Schema.optional(Schema.String),
  approvalUrl: Schema.optional(Schema.String),
});

const PauseEnvelopeFromText = Schema.fromJsonString(PauseEnvelopeSchema);

type PauseEnvelope = typeof PauseEnvelopeSchema.Type;

/** A pause Executor reported, with the payload it came in. */
type Pause = { readonly envelope: PauseEnvelope; readonly raw: string };

/**
 * The pause a result reports, read from the result's structure, never searched
 * for in its text. `structuredContent` is Executor's envelope whenever it sends
 * one, so when it is present it is the only thing read: a tool's output in the
 * text section cannot speak for it. A result with no `structuredContent` is
 * read as one text item that is, in its entirety, the envelope.
 */
const pauseOf = (result: CallToolResult): Pause | undefined => {
  const structured = result.structuredContent;
  if (structured !== undefined) {
    return Option.getOrUndefined(
      Option.map(Schema.decodeUnknownOption(PauseEnvelopeSchema)(structured), (envelope) => ({
        envelope,
        raw: toJson(structured),
      })),
    );
  }
  const [only, ...rest] = result.content;
  if (only === undefined || only.type !== "text" || rest.length > 0) return undefined;
  const text = only.text.trim();
  return Option.getOrUndefined(
    Option.map(Schema.decodeUnknownOption(PauseEnvelopeFromText)(text), (envelope) => ({
      envelope,
      raw: text,
    })),
  );
};

const requestIdOfPause = (pause: Pause): string | undefined =>
  pause.envelope.requestId ?? pause.envelope.executionId;

/**
 * The envelope of a paused result, or `undefined`. A pause with no `requestId`
 * is not one: nothing can resume it and there is nothing durable to record, so
 * the notice still guides the model but no approval row is written.
 */
const pausedEnvelope = (pause: Pause | undefined): PausedEnvelope | undefined => {
  if (pause === undefined) return undefined;
  const requestId = requestIdOfPause(pause);
  if (requestId === undefined) return undefined;
  return { requestId, envelope: pause.raw };
};

const JsonFromText = Schema.fromJsonString(Schema.Unknown);

const ExecutionOutcomeSchema = Schema.Struct({
  execution: Schema.optional(Schema.Struct({ ok: Schema.Boolean })),
});
const ExecutionOutcomeFromText = Schema.fromJsonString(ExecutionOutcomeSchema);

/**
 * Whether the envelope reports a failed program. Executor sets `isError` on a
 * refusal at the MCP layer, but a program that fails inside an otherwise
 * successful call comes back as a normal result, with `execution.ok` false and
 * `execution.error` naming the failure. That flag is the only place the failure
 * is recorded, so without reading it the result looks answered.
 *
 * A failed individual call is not this. It is reported per call, inside
 * `execution.value`, and an array of calls can mix successes with failures, so
 * marking the whole result as an error would misstate it.
 */
const programFailed = (json: string): boolean => {
  const decoded = Option.getOrElse(
    Schema.decodeUnknownOption(ExecutionOutcomeFromText)(json),
    () => undefined,
  );
  return decoded?.execution?.ok === false;
};

/** Whether the text section already is the structured payload, serialized. */
const repeatsStructured = (text: string, structured: string): boolean => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const parsed = Option.getOrElse(
    Schema.decodeUnknownOption(JsonFromText)(trimmed),
    () => undefined,
  );
  return parsed !== undefined && toJson(parsed) === structured;
};

const renderBody = (text: string, structured: string): string => {
  const parts: string[] = [];
  if (text.length > 0) parts.push(text);
  if (structured.length > 0) parts.push(`structuredContent:\n${structured}`);
  return parts.length > 0 ? parts.join("\n\n") : "(Executor returned no content)";
};

/**
 * Hand a paused envelope to the sink. A sink failure must not change the result
 * the model sees, but a lost approval is the loop stalling invisibly, so it is
 * logged rather than swallowed.
 */
const announcePaused = (
  onPaused: (paused: PausedEnvelope) => void,
  paused: PausedEnvelope,
): void => {
  const exit = Effect.runSync(Effect.exit(Effect.sync(() => onPaused(paused))));
  if (Exit.isFailure(exit)) {
    console.error(`mackbot: recording a paused executor call failed: ${Cause.pretty(exit.cause)}`);
  }
};

/**
 * Map an MCP `CallToolResult` onto a pi tool result. A paused approval gets a
 * prominent header; failures come back as `isError` results so the model can
 * react instead of the harness throwing. Exported so the rendering can be
 * checked against synthetic envelopes without a live Executor.
 *
 * `onPaused` is called with what a paused envelope carries, so the host can
 * record it; a sink that throws cannot change the result the model sees.
 */
export const renderResult = (
  result: CallToolResult,
  onPaused?: (paused: PausedEnvelope) => void,
): ToolExecutionResult => {
  const text = renderContent(result.content);
  const structuredContent = result.structuredContent;
  const compact = structuredContent === undefined ? "" : toJson(structuredContent);
  // Executor answers most tools with the same payload in `content` and in
  // `structuredContent`. Rendering both charges the model twice for one result,
  // so the structured section is dropped when it only repeats the text. A text
  // section that is not that same JSON still keeps it.
  const structured =
    structuredContent === undefined || repeatsStructured(text, compact)
      ? ""
      : toPrettyJson(structuredContent);
  const body = renderBody(text, structured);
  const pause = pauseOf(result);
  const paused = pausedEnvelope(pause);
  if (paused !== undefined && onPaused !== undefined) {
    announcePaused(onPaused, paused);
  }
  const output =
    pause === undefined
      ? body
      : `${noticeOf(pause.envelope.approvalUrl, requestIdOfPause(pause))}\n\n${body}`;
  // Reads the whole payload even when it was not rendered, so dropping a repeat
  // cannot hide a failure.
  const failed = programFailed(compact);
  return {
    output: [textItem(output)],
    isError: result.isError === true || failed,
  };
};

const runMetaTool = (
  bridge: Bridge,
  name: string,
  args: McpToolArguments,
  shared: boolean,
  paused: PausedSink | undefined,
  session: string,
): Effect.Effect<ToolExecutionResult> =>
  callMetaTool(bridge, name, args, shared).pipe(
    Effect.match({
      onSuccess: (result) =>
        renderResult(
          result,
          paused === undefined ? undefined : (found) => paused({ ...found, session }),
        ),
      onFailure: (cause) => failureResult(bridge.config, name, cause),
    }),
  );

/**
 * The result a failed call gives the model. The failure's words help it react
 * (a validation error, a timeout), but they go into the transcript and on to
 * the model provider, so they are redacted and bounded; the log keeps the
 * whole failure, with the credential still taken out.
 */
export const failureResult = (
  config: { readonly url: string; readonly token: string },
  name: string,
  cause: unknown,
): ToolExecutionResult => {
  const detail = describeCause(cause);
  const logged = config.token.length > 0 ? detail.split(config.token).join("[redacted]") : detail;
  console.error(`mackbot: Executor MCP call failed (${name}): ${logged}`);
  const redacted = redactSecrets(detail, config);
  const bounded =
    redacted.length > MAX_ERROR_CHARS ? `${redacted.slice(0, MAX_ERROR_CHARS)}…` : redacted;
  return errorResult(`Executor MCP call failed (${name}): ${bounded}`);
};

/**
 * What an MCP app tool answered through Executor: its own content list, as
 * the tool returned it.
 */
const ExecutorToolValueSchema = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
  ),
});

export type ExecutorToolValue = typeof ExecutorToolValueSchema.Type;

/**
 * How one harness-issued call to an app tool ended. `paused` means Executor
 * gated the call for approval; the harness made it, not the model, so nobody
 * is there to resume it. A completed call carries the tool's content when it
 * answered with any.
 */
export type ExecutorCallOutcome =
  | { readonly kind: "completed"; readonly value?: ExecutorToolValue }
  | { readonly kind: "paused" }
  | { readonly kind: "failed"; readonly detail: string };

/**
 * The single call's own verdict. `call` answers `execution.ok: true` for a
 * call Executor ran, and reports the tool's own failure (an invalid input, a
 * refused request) one level down, in `execution.value.ok`, beside the tool's
 * result in `execution.value.value`.
 */
const SingleCallOutcomeSchema = Schema.Struct({
  execution: Schema.Struct({
    ok: Schema.Boolean,
    value: Schema.optional(
      Schema.Struct({
        ok: Schema.optional(Schema.Boolean),
        value: Schema.optional(Schema.Unknown),
        error: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.String) })),
      }),
    ),
  }),
});

/**
 * Classify the result of one `call` to an app tool. A pause is read the way
 * {@link renderResult} reads it, from Executor's own envelope only, and it is
 * never handed to an approval sink.
 */
export const executorCallOutcomeOf = (
  result: CallToolResult,
  secrets: { readonly url: string; readonly token: string },
): ExecutorCallOutcome => {
  if (pauseOf(result) !== undefined) return { kind: "paused" };
  const failed = (detail: string): ExecutorCallOutcome => {
    const redacted = redactSecrets(detail, secrets);
    return {
      kind: "failed",
      detail:
        redacted.length > MAX_ERROR_CHARS ? `${redacted.slice(0, MAX_ERROR_CHARS)}…` : redacted,
    };
  };
  if (result.isError === true) return failed(renderContent(result.content));
  const outcome = Option.getOrUndefined(
    Schema.decodeUnknownOption(SingleCallOutcomeSchema)(result.structuredContent),
  );
  if (outcome === undefined) return { kind: "completed" };
  if (!outcome.execution.ok || outcome.execution.value?.ok === false) {
    return failed(outcome.execution.value?.error?.message ?? renderContent(result.content));
  }
  return {
    kind: "completed",
    value: Option.getOrUndefined(
      Schema.decodeUnknownOption(ExecutorToolValueSchema)(outcome.execution.value?.value),
    ),
  };
};

/**
 * Executor reached from harness code rather than from the model: a `describe`
 * of exact paths, and one direct `call`. Each opens its own connection, like
 * the model's unsafe tools, and neither touches the paused-call sink.
 */
export type ExecutorToolClient = {
  readonly describe: (paths: readonly string[]) => Effect.Effect<CallToolResult, string>;
  readonly call: (
    path: string,
    input: McpToolArguments,
  ) => Effect.Effect<ExecutorCallOutcome, string>;
};

export function createExecutorToolClient(
  config: ExecutorMcpConfig,
  options?: { readonly connect?: (config: ResolvedConfig) => Promise<Client> },
): ExecutorToolClient {
  const bridge = makeBridge(config, options?.connect ?? openClient);
  // A transport failure quotes the URL it failed on, which names the org
  // connection, so the host only ever sees it redacted.
  const redacted = (cause: unknown): string => redactSecrets(describeCause(cause), bridge.config);
  return {
    describe: (paths) =>
      Effect.mapError(callMetaTool(bridge, "describe", { paths: [...paths] }, false), redacted),
    call: (path, input) =>
      callMetaTool(bridge, "call", { calls: { path, input } }, false).pipe(
        Effect.map((result) => executorCallOutcomeOf(result, bridge.config)),
        Effect.mapError(redacted),
      ),
  };
}

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

const searchTool = (bridge: Bridge, paused: PausedSink | undefined) =>
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
    execute: (args, api) =>
      Effect.runPromise(
        runMetaTool(bridge, "search", args, true, paused, String(api.conversationId)),
      ),
  });

const describeTool = (bridge: Bridge, paused: PausedSink | undefined) =>
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
    execute: (args, api) =>
      Effect.runPromise(
        runMetaTool(bridge, "describe", args, true, paused, String(api.conversationId)),
      ),
  });

const callTool = (bridge: Bridge, paused: PausedSink | undefined) =>
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
    execute: (args, api) =>
      Effect.runPromise(
        runMetaTool(bridge, "call", args, false, paused, String(api.conversationId)),
      ),
  });

const executeTool = (bridge: Bridge, paused: PausedSink | undefined) =>
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
    execute: (args, api) =>
      Effect.runPromise(
        runMetaTool(bridge, "execute", args, false, paused, String(api.conversationId)),
      ),
  });

const skillsTool = (bridge: Bridge, paused: PausedSink | undefined) =>
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
    execute: (args, api) =>
      Effect.runPromise(
        runMetaTool(bridge, "skills", args, true, paused, String(api.conversationId)),
      ),
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

const resumeTool = (bridge: Bridge, paused: PausedSink | undefined) =>
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
    execute: (args, api) =>
      Effect.runPromise(
        runMetaTool(bridge, "resume", args, false, paused, String(api.conversationId)),
      ),
  });

/**
 * Build the Executor v2 bridge extension: six pi tools plus the
 * `executor-protocol` prompt section. Give the result to the harness registry
 * (`registry.install(...)`) or select it on a conversation's agent.
 *
 * `connect` is the seam a test uses to count connections, so the sharing policy
 * for the read-only tools can be checked without a live Executor. `onPaused` is
 * where a paused call is recorded; it is called with the requestId and the
 * envelope, and the host turns that into an approval row.
 */
export function createExecutorMcp(
  config: ExecutorMcpConfig,
  options?: {
    readonly connect?: (config: ResolvedConfig) => Promise<Client>;
    readonly onPaused?: PausedSink;
  },
): Extension {
  const paused = options?.onPaused;
  const bridge = makeBridge(config, options?.connect ?? openClient);
  return defineExtension({
    name: "executor-mcp",
    tools: [
      searchTool(bridge, paused),
      describeTool(bridge, paused),
      callTool(bridge, paused),
      executeTool(bridge, paused),
      skillsTool(bridge, paused),
      resumeTool(bridge, paused),
    ],
    sections: [executorProtocolSection],
  });
}
