/**
 * Smoke test for the approval loop end to end: the Executor bridge's pause sink
 * (src/executor-mcp.ts), the approval store and its decision path
 * (src/approvals.ts), and the front door's `POST /approvals/:bot/:approvalId`
 * (src/index.ts).
 *
 * Run with: bun tests/approvals.smoke.mjs
 *
 * The claims this file has to break if they stop holding:
 *   1. A paused envelope records exactly one row, carrying the draft the UI
 *      needs; the same pause recorded twice is still one row.
 *   2. A decision flips the status and admits exactly one steering submission,
 *      whose text carries the requestId; a decision on an already-decided
 *      approval is refused rather than replayed.
 *   3. Executor's `requestId` is durable but never leaves the Durable Object:
 *      it appears in no route response and in no Frame.
 *   4. The status projection reports the approval as pending before the
 *      decision and absent after it.
 *
 * The Executor bridge has no live Executor, so this supplies its own connection
 * through the `connect` seam, exactly as tests/executor-mcp-connection.smoke.mjs
 * does. `src/index.ts` imports the `cloudflare:workers` builtin for
 * `DurableObject`, which Bun cannot resolve, so this re-execs with
 * `tests/shims` on NODE_PATH the way tests/routes.smoke.mjs does. A live
 * Durable Object is not available, so the Bot binding is faked over the real
 * store.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
if (process.env.MACKBOT_WORKERS_SHIM !== "1") {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_PATH: join(here, "shims"),
      MACKBOT_WORKERS_SHIM: "1",
    },
  });
  process.exit(result.status ?? 1);
}

const { Database } = await import("bun:sqlite");
const { Schema } = await import("effect");
const { sqliteStorage } = await import("./support/sqlite.mjs");
const { createApprovalStore } = await import("../src/approvals.ts");
const { createExecutorMcp } = await import("../src/executor-mcp.ts");
const { projectStatus } = await import("../src/status.ts");
const { FrameSchema } = await import("../src/web-contract.ts");
const worker = (await import("../src/index.ts")).default;

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
};

/** How many times `needle` appears in `haystack`: the measurement for "never". */
const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

const TOKEN = "test-token";
const REQUEST_ID = "apr_round_trip_7";
const BARE_REQUEST_ID = "apr_bare_8";
const DENIED_REQUEST_ID = "apr_denied_9";

// A pause as Executor returns it: the invocation and its input are the draft the
// approval previews, and the approvalUrl is a credential-bearing link that must
// be relayed rather than stored.
const PAUSE = {
  status: "approval-required",
  requestId: REQUEST_ID,
  invocation: {
    path: "botmail.send",
    tool: "send",
    input: { to: "arena@northwind.co", subject: "Q3 renewal", body: "Hi Dana," },
  },
  approvalUrl: "https://app.executor.sh/mcp/approve/apr_round_trip_7?grantId=pat%3A%7B%22token%22%3A%22secret%22%7D",
};

// The bare pause `model` elicitation mode returns: a requestId and little else.
const BARE_PAUSE = { status: "approval-required", requestId: BARE_REQUEST_ID };

const fresh = () => {
  const database = new Database(":memory:");
  return { database, store: createApprovalStore(sqliteStorage(database)) };
};

/** A bridge over a fake connection that answers every call with `envelope`. */
const bridgeTools = (store, envelope, paused) => {
  const connect = async () => ({
    request: async () => ({
      content: [{ type: "text", text: JSON.stringify(envelope) }],
      structuredContent: envelope,
    }),
    close: async () => {},
  });
  const extension = createExecutorMcp(
    { url: "https://example.invalid/mcp", token: "x" },
    {
      connect,
      onPaused: (found) => {
        paused.push(found);
        store.recordPaused({
          bot: "hermes",
          session: found.session,
          requestId: found.requestId,
          envelope: found.envelope,
        });
      },
    },
  );
  return new Map((extension.tools ?? []).map((tool) => [tool.name, tool]));
};

const call = (tools) =>
  tools
    .get("executor_call")
    .execute({ calls: { path: "tools.botmail.send", input: {} } }, { conversationId: 7 }, {});

// ---------------------------------------------------------------------------
// The write path: the bridge finds the pause, the store records it.
// ---------------------------------------------------------------------------

{
  const { database, store } = fresh();
  const paused = [];
  const tools = bridgeTools(store, PAUSE, paused);
  await call(tools);

  const pending = store.pending();
  check("a paused result reaches the sink", paused.length === 1, `${paused.length}`);
  check("the sink carries the requestId", paused[0]?.requestId === REQUEST_ID, paused[0]?.requestId);
  check("the sink carries the session", paused[0]?.session === "7", paused[0]?.session);
  check("a paused result records exactly one row", pending.length === 1, `${pending.length}`);
  check("the row is pending", pending[0]?.status === "pending", pending[0]?.status);
  check("the row names the paused tool", pending[0]?.toolPath === "botmail.send", pending[0]?.toolPath);
  check(
    "the row carries the draft the UI renders",
    occurrences(pending[0]?.artifact?.body ?? "", "arena@northwind.co") === 1,
    `to x${occurrences(pending[0]?.artifact?.body ?? "", "arena@northwind.co")}`,
  );
  check(
    "the draft is labelled for the card",
    pending[0]?.artifact?.label === "botmail.send — what it will do",
    pending[0]?.artifact?.label,
  );

  const persisted = database.query("SELECT * FROM mackbot_approvals").get();
  check("the requestId is durable", persisted.request_id === REQUEST_ID, `${persisted.request_id}`);
  check("the session is durable", persisted.session_id === "7", `${persisted.session_id}`);
  check("the artifact is durable", `${persisted.artifact}`.includes("arena@northwind.co"));
  check(
    "the signed approval link is never stored",
    occurrences(JSON.stringify(persisted), "grantId") === 0,
    `grantId x${occurrences(JSON.stringify(persisted), "grantId")}`,
  );

  const firstId = pending[0]?.approvalId;
  await call(tools);
  check("the sink saw the same pause twice", paused.length === 2, `${paused.length}`);
  check(
    "the same pause recorded twice stays one row",
    store.pending().length === 1,
    `${store.pending().length}`,
  );
  check("the row keeps its first id", store.pending()[0]?.approvalId === firstId);
}

// ---------------------------------------------------------------------------
// A pause the envelope says nothing about records what it does carry.
// ---------------------------------------------------------------------------

{
  const { store } = fresh();
  const paused = [];
  const tools = bridgeTools(store, BARE_PAUSE, paused);
  await call(tools);

  const pending = store.pending();
  check("a bare pause is still one row", pending.length === 1, `${pending.length}`);
  check("a bare pause carries no artifact", pending[0]?.artifact === undefined);
  check(
    "the summary says plainly that no draft came with it",
    /carried no/i.test(pending[0]?.summary ?? ""),
    pending[0]?.summary,
  );
  check("the tool path falls back rather than inventing one", pending[0]?.toolPath === "executor", pending[0]?.toolPath);
}

// ---------------------------------------------------------------------------
// A failing sink is logged, never fatal: the model still gets the pause notice.
// ---------------------------------------------------------------------------

{
  const extension = createExecutorMcp(
    { url: "https://example.invalid/mcp", token: "x" },
    {
      connect: async () => ({
        request: async () => ({
          content: [{ type: "text", text: JSON.stringify(PAUSE) }],
          structuredContent: PAUSE,
        }),
        close: async () => {},
      }),
      onPaused: () => {
        throw new Error("the approval write blew up");
      },
    },
  );
  const tools = new Map((extension.tools ?? []).map((tool) => [tool.name, tool]));
  const result = await call(tools);
  const text = (result.output ?? []).map((item) => item.text).join("\n");
  check("a throwing sink does not fail the tool result", result.isError === false, `${result.isError}`);
  check("a throwing sink still surfaces the pause notice", text.includes("APPROVAL REQUIRED"), text.slice(0, 40));
}

// ---------------------------------------------------------------------------
// The requestId is DO-private: never in the view, never in a Frame.
// ---------------------------------------------------------------------------

{
  const { store } = fresh();
  store.recordPaused({
    bot: "hermes",
    session: "7",
    requestId: REQUEST_ID,
    envelope: JSON.stringify(PAUSE),
  });
  const view = store.pending()[0];
  const frame = { kind: "approval", approval: view };
  const serialized = JSON.stringify(frame);
  check("the approval view is a valid Frame payload", Schema.is(FrameSchema)(frame));
  check("the Frame names the approval", serialized.includes(view.approvalId));
  check(
    "the requestId appears in no Frame",
    occurrences(serialized, REQUEST_ID) === 0,
    `requestId x${occurrences(serialized, REQUEST_ID)}`,
  );
  check(
    "the requestId appears in no projected view",
    occurrences(JSON.stringify(view), REQUEST_ID) === 0,
    `requestId x${occurrences(JSON.stringify(view), REQUEST_ID)}`,
  );
}

// ---------------------------------------------------------------------------
// The decision path: durable first, then exactly one steering submission.
// ---------------------------------------------------------------------------

{
  const { database, store } = fresh();
  store.recordPaused({
    bot: "hermes",
    session: "7",
    requestId: REQUEST_ID,
    envelope: JSON.stringify(PAUSE),
  });
  const approvalId = store.pending()[0].approvalId;
  const submissions = [];
  const submit = async (input, operationId, whenBusy, session) => {
    submissions.push({ input, operationId, whenBusy, session });
    return { accepted: true };
  };

  const decided = await store.decide(approvalId, { action: "allow" }, submit);
  check("a decision names the approval", decided?.approvalId === approvalId, JSON.stringify(decided));
  check("an allowed decision is recorded as allowed", decided?.status === "allowed", decided?.status);
  const decidedRow = database
    .query("SELECT status, decided_at FROM mackbot_approvals WHERE approval_id = ?")
    .get(approvalId);
  check("the decision is durable", decidedRow.status === "allowed", decidedRow.status);
  check("the decision carries a time", decidedRow.decided_at > 0, `${decidedRow.decided_at}`);
  check("exactly one steering submission is admitted", submissions.length === 1, `${submissions.length}`);
  check(
    "the steer carries the requestId",
    occurrences(submissions[0]?.input ?? "", REQUEST_ID) >= 1,
    `requestId x${occurrences(submissions[0]?.input ?? "", REQUEST_ID)}`,
  );
  check("the steer names executor_resume", submissions[0]?.input.includes("executor_resume"));
  check(
    "the steer asks for the decided action",
    submissions[0]?.input.includes('"action":"accept"'),
    `accept x${occurrences(submissions[0]?.input ?? "", '"action":"accept"')}`,
  );
  check(
    "the steer's operation id is derived from the approval",
    submissions[0]?.operationId.includes(approvalId),
    submissions[0]?.operationId,
  );
  check("the steer goes to the pausing session", submissions[0]?.session === "7", submissions[0]?.session);
  check("the steer is a steer", submissions[0]?.whenBusy === "steer", submissions[0]?.whenBusy);
  check("the decision leaves pending", store.pending().length === 0, `${store.pending().length}`);

  const replayed = await store.decide(approvalId, { action: "deny" }, submit);
  check("a second decision is refused", replayed === undefined, JSON.stringify(replayed));
  check("a refused decision admits no submission", submissions.length === 1, `${submissions.length}`);

  store.recordPaused({
    bot: "hermes",
    session: "7",
    requestId: DENIED_REQUEST_ID,
    envelope: JSON.stringify(BARE_PAUSE),
  });
  const denyId = store.pending()[0].approvalId;
  await store.decide(denyId, { action: "deny" }, submit);
  check("a deny steers a decline", submissions.at(-1)?.input.includes('"action":"decline"'));
  check("a deny leaves pending", store.pending().length === 0, `${store.pending().length}`);
}

// ---------------------------------------------------------------------------
// The route: the same loop through the front door, over a faked Bot binding.
// ---------------------------------------------------------------------------

const statusFacts = (approvals) => ({
  id: "hermes",
  model: { provider: "opencode-go", id: "deepseek-v4-pro" },
  thinkingLevel: "high",
  busy: false,
  pending: [],
  usage: { models: {}, tools: {} },
  approvals,
  runs: [],
});

const routeEnv = (store, submissions) => ({
  CHAT_BEARER_TOKEN: TOKEN,
  Bot: {
    getByName: () => ({
      status: async () => projectStatus(statusFacts(store.pending())),
      decide: async (approvalId, decision) =>
        store.decide(approvalId, decision, async (input, operationId, whenBusy, session) => {
          submissions.push({ input, operationId, whenBusy, session });
          return { accepted: true };
        }),
    }),
  },
});

{
  const { store } = fresh();
  store.recordPaused({
    bot: "hermes",
    session: "7",
    requestId: REQUEST_ID,
    envelope: JSON.stringify(PAUSE),
  });
  const approvalId = store.pending()[0].approvalId;
  const submissions = [];
  const env = routeEnv(store, submissions);
  const get = (path, headers = {}) =>
    worker.fetch(new Request(`https://mackbot.test${path}`, { headers }), env);
  const post = (path, body, headers = {}) =>
    worker.fetch(
      new Request(`https://mackbot.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      env,
    );

  const unauthorized = await post(`/approvals/hermes/${approvalId}`, { action: "allow" });
  check("an unauthenticated decision is 401", unauthorized.status === 401, `${unauthorized.status}`);
  check("an unauthenticated decision steers nothing", submissions.length === 0);

  const before = await get("/status", { Authorization: `Bearer ${TOKEN}` });
  const beforeBody = await before.json();
  const beforeApprovals = JSON.stringify(beforeBody.bots.hermes.approvals);
  check("status is 200", before.status === 200, `${before.status}`);
  check(
    "the status projection reports the approval as pending",
    beforeApprovals.includes(approvalId) && beforeApprovals.includes('"status":"pending"'),
    JSON.stringify(beforeBody.bots.hermes.approvals.map((a) => a.status)),
  );
  check(
    "no requestId in the status response",
    occurrences(beforeApprovals, REQUEST_ID) === 0,
    `requestId x${occurrences(beforeApprovals, REQUEST_ID)}`,
  );

  const bad = await post(
    `/approvals/hermes/${approvalId}`,
    { action: "maybe" },
    { Authorization: `Bearer ${TOKEN}` },
  );
  check("an undecodable decision body is 400", bad.status === 400, `${bad.status}`);
  check("an undecodable decision steers nothing", submissions.length === 0);

  const unknown = await post(
    `/approvals/nobody/${approvalId}`,
    { action: "allow" },
    { Authorization: `Bearer ${TOKEN}` },
  );
  check("a decision for an unknown bot is 404", unknown.status === 404, `${unknown.status}`);

  const decided = await post(
    `/approvals/hermes/${approvalId}`,
    { action: "allow" },
    { Authorization: `Bearer ${TOKEN}` },
  );
  check("an authenticated decision is 200", decided.status === 200, `${decided.status}`);
  const decidedBody = await decided.json();
  check("the decision response reports allowed", decidedBody.status === "allowed", JSON.stringify(decidedBody));
  check("the decision response names the approval", decidedBody.approvalId === approvalId);
  check(
    "no requestId in the decision response",
    occurrences(JSON.stringify(decidedBody), REQUEST_ID) === 0,
    `requestId x${occurrences(JSON.stringify(decidedBody), REQUEST_ID)}`,
  );
  check("exactly one steer from the route", submissions.length === 1, `${submissions.length}`);
  check("the route's steer carries the requestId", submissions[0]?.input.includes(REQUEST_ID));

  const replayed = await post(
    `/approvals/hermes/${approvalId}`,
    { action: "deny" },
    { Authorization: `Bearer ${TOKEN}` },
  );
  check("a replayed decision is refused, not replayed", replayed.status === 409, `${replayed.status}`);
  check("a refused replay steers nothing", submissions.length === 1, `${submissions.length}`);

  const after = await get("/status", { Authorization: `Bearer ${TOKEN}` });
  const afterBody = await after.json();
  const afterApprovals = JSON.stringify(afterBody.bots.hermes.approvals);
  check(
    "the status projection no longer reports the approval",
    !afterApprovals.includes(approvalId),
    afterApprovals,
  );
  check(
    "no requestId in the status response after the decision",
    occurrences(afterApprovals, REQUEST_ID) === 0,
    `requestId x${occurrences(afterApprovals, REQUEST_ID)}`,
  );

  const notPost = await get(`/approvals/hermes/${approvalId}`, { Authorization: `Bearer ${TOKEN}` });
  check("a non-POST decision is 405", notPost.status === 405, `${notPost.status}`);
}

if (failures.length > 0) {
  console.error("approvals smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("approvals smoke passed");
process.exit(0);
