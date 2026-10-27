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
 *   5. A pause starts one durable wait, and the wait delivers a decided
 *      approval under the same operation id the HTTP path used, so a second
 *      delivery joins the first submission instead of starting a second run.
 *   6. The wait gives up when nobody decides it before its deadline.
 *
 * The Executor bridge has no live Executor, so this supplies its own connection
 * through the `connect` seam, exactly as tests/executor-mcp-connection.smoke.mjs
 * does. `src/index.ts` imports the `cloudflare:workers` builtin for
 * `DurableObject`, which Bun cannot resolve, so this re-execs under the shim in
 * `tests/support/workers-shim.mjs` the way tests/routes.smoke.mjs does. A live
 * Durable Object is not available, so the Bot binding is faked over the real
 * store. The wait's phases are driven with a fake runtime, because a Harness
 * over a real storage would only prove the library's own machinery.
 */
import { withWorkersShim } from "./support/workers-shim.mjs";

withWorkersShim(import.meta.url);

const { Database } = await import("bun:sqlite");
const { Schema } = await import("effect");
const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
const { Harness, MemoryStorage, createRegistry, defineExtension } =
  await import("@earendil-works/pi-durable");
const { createModels } = await import("@earendil-works/pi-ai/models");
const { sqliteStorage } = await import("./support/sqlite.mjs");
const { createApprovalStore, ApprovalWait } = await import("../src/approvals.ts");
const { createExecutorPolicy } = await import("../src/executor-policy.ts");
const { createExecutorMcp } = await import("../src/executor-mcp.ts");
const { projectStatus } = await import("../src/status.ts");
const { FrameSchema } = await import("@mackbot/contract");
const worker = (await import("../src/index.ts")).default;
const { registryBinding } = await import("./support/registry.mjs");

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
};

/** How many times `needle` appears in `haystack`: the measurement for "never". */
const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

/** Whether a value is a string, without narrowing on its representation. */
const isText = (value) => Object.prototype.toString.call(value) === "[object String]";

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
  approvalUrl:
    "https://app.executor.sh/mcp/approve/apr_round_trip_7?grantId=pat%3A%7B%22token%22%3A%22secret%22%7D",
};

// The bare pause `model` elicitation mode returns: a requestId and little else.
const BARE_PAUSE = { status: "approval-required", requestId: BARE_REQUEST_ID };

const fresh = (options) => {
  const database = new Database(":memory:");
  return { database, store: createApprovalStore(sqliteStorage(database), options) };
};

/** A submitter that records what it was asked to submit. */
const recorder = (submissions) => async (input, operationId, whenBusy, session) => {
  submissions.push({ input, operationId, whenBusy, session });
  return { accepted: true };
};

/**
 * Drive one phase of the wait task. The fake runtime records what the phase
 * committed and the clock it slept until, so the test reads the wait's own
 * decisions rather than the harness's machinery.
 */
const drivePhase = async (phase, { input, checkpoint, now }) => {
  const commits = [];
  const sleeps = [];
  const runtime = {
    now: () => now,
    commit: async (change) => {
      commits.push(await change({}, undefined));
    },
    sleepUntil: async (until, next) => {
      sleeps.push({ until, checkpoint: next });
    },
  };
  const task = { id: 1, input, state: { status: "running", checkpoint } };
  await ApprovalWait.definition.phases[phase](task, runtime, BACKGROUND_CONTEXT);
  return { commits, sleeps };
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
  check(
    "the sink carries the requestId",
    paused[0]?.requestId === REQUEST_ID,
    paused[0]?.requestId,
  );
  check("the sink carries the session", paused[0]?.session === "7", paused[0]?.session);
  check("a paused result records exactly one row", pending.length === 1, `${pending.length}`);
  check("the row is pending", pending[0]?.status === "pending", pending[0]?.status);
  check(
    "the row names the paused tool",
    pending[0]?.toolPath === "botmail.send",
    pending[0]?.toolPath,
  );
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
  check(
    "the tool path falls back rather than inventing one",
    pending[0]?.toolPath === "executor",
    pending[0]?.toolPath,
  );
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
  check(
    "a throwing sink does not fail the tool result",
    result.isError === false,
    `${result.isError}`,
  );
  check(
    "a throwing sink still surfaces the pause notice",
    text.includes("APPROVAL REQUIRED"),
    text.slice(0, 40),
  );
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
  check(
    "a decision names the approval",
    decided?.approvalId === approvalId,
    JSON.stringify(decided),
  );
  check(
    "an allowed decision is recorded as allowed",
    decided?.status === "allowed",
    decided?.status,
  );
  const decidedRow = database
    .query("SELECT status, decided_at FROM mackbot_approvals WHERE approval_id = ?")
    .get(approvalId);
  check("the decision is durable", decidedRow.status === "allowed", decidedRow.status);
  check("the decision carries a time", decidedRow.decided_at > 0, `${decidedRow.decided_at}`);
  check(
    "exactly one steering submission is admitted",
    submissions.length === 1,
    `${submissions.length}`,
  );
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
  check(
    "the steer goes to the pausing session",
    submissions[0]?.session === "7",
    submissions[0]?.session,
  );
  check("the steer is a steer", submissions[0]?.whenBusy === "steer", submissions[0]?.whenBusy);
  check("the decision leaves pending", store.pending().length === 0, `${store.pending().length}`);

  const replayed = await store.decide(approvalId, { action: "deny" }, submit);
  check("a second decision is refused", replayed === undefined, JSON.stringify(replayed));
  check(
    "a refused decision admits no submission",
    submissions.length === 1,
    `${submissions.length}`,
  );

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
// The state the executor policy asks about, and what the policy does with it.
// A paused call ends only by a human's decision, so the state has to say which
// decision, not merely that one happened.
// ---------------------------------------------------------------------------

{
  const { store } = fresh();
  store.recordPaused({
    bot: "hermes",
    session: "7",
    requestId: REQUEST_ID,
    envelope: JSON.stringify(PAUSE),
  });
  const approvalId = store.pending()[0].approvalId;
  const submit = async () => ({ accepted: true });

  const policy = createExecutorPolicy({
    approvalState: (requestId) => store.stateOf(requestId),
    onCall: () => {},
  });
  const beforeTool = policy.hooks[0].handlers.beforeTool;
  const resume = (requestId, response) =>
    beforeTool(
      {
        type: "toolCall",
        id: "call-1",
        name: "executor_resume",
        arguments: { requestId, response },
      },
      {},
      BACKGROUND_CONTEXT,
    );

  check(
    "a pause nobody answered is pending",
    store.stateOf(REQUEST_ID) === "pending",
    store.stateOf(REQUEST_ID),
  );
  check(
    "an approval nobody saw is unknown",
    store.stateOf("req-never-seen") === "unknown",
    store.stateOf("req-never-seen"),
  );
  check(
    "a pending approval cannot be resumed",
    isText(resume(REQUEST_ID, { action: "accept" })?.block),
    JSON.stringify(resume(REQUEST_ID, { action: "accept" })),
  );

  await store.decide(approvalId, { action: "allow" }, submit);
  check(
    "an approved approval says so",
    store.stateOf(REQUEST_ID) === "approved",
    store.stateOf(REQUEST_ID),
  );
  check(
    "an approved approval can be resumed",
    resume(REQUEST_ID, { action: "accept" }) === undefined,
    JSON.stringify(resume(REQUEST_ID, { action: "accept" })),
  );

  const { store: other } = fresh();
  other.recordPaused({
    bot: "hermes",
    session: "7",
    requestId: DENIED_REQUEST_ID,
    envelope: JSON.stringify(BARE_PAUSE),
  });
  const denyId = other.pending()[0].approvalId;
  await other.decide(denyId, { action: "deny" }, submit);
  check(
    "a refused approval says so",
    other.stateOf(DENIED_REQUEST_ID) === "denied",
    other.stateOf(DENIED_REQUEST_ID),
  );

  const deniedPolicy = createExecutorPolicy({
    approvalState: (requestId) => other.stateOf(requestId),
    onCall: () => {},
  });
  const deniedResume = (requestId, response) =>
    deniedPolicy.hooks[0].handlers.beforeTool(
      {
        type: "toolCall",
        id: "call-1",
        name: "executor_resume",
        arguments: { requestId, response },
      },
      {},
      BACKGROUND_CONTEXT,
    );
  check(
    "a refusal cannot be carried out",
    isText(deniedResume(DENIED_REQUEST_ID, { action: "accept" })?.block),
    JSON.stringify(deniedResume(DENIED_REQUEST_ID, { action: "accept" })),
  );
  check(
    "a refusal may be carried back to Executor",
    deniedResume(DENIED_REQUEST_ID, { action: "decline" }) === undefined,
    JSON.stringify(deniedResume(DENIED_REQUEST_ID, { action: "decline" })),
  );
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
  Registry: registryBinding(),
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
  check(
    "an unauthenticated decision is 401",
    unauthorized.status === 401,
    `${unauthorized.status}`,
  );
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
  check(
    "the decision response reports allowed",
    decidedBody.status === "allowed",
    JSON.stringify(decidedBody),
  );
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
  check(
    "a replayed decision is refused, not replayed",
    replayed.status === 409,
    `${replayed.status}`,
  );
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

  const notPost = await get(`/approvals/hermes/${approvalId}`, {
    Authorization: `Bearer ${TOKEN}`,
  });
  check("a non-POST decision is 405", notPost.status === 405, `${notPost.status}`);
}

// ---------------------------------------------------------------------------
// The wait: a pause leaves a durable task behind, and the task delivers.
// ---------------------------------------------------------------------------

{
  const waits = [];
  const submissions = [];
  const { store } = fresh({
    startWait: (wait) => {
      waits.push(wait);
    },
    submit: recorder(submissions),
  });
  store.recordPaused({
    bot: "hermes",
    session: "7",
    requestId: REQUEST_ID,
    envelope: JSON.stringify(PAUSE),
  });
  const approvalId = store.pending()[0].approvalId;

  check("the pause starts a wait", waits.length === 1, `${waits.length}`);
  check("the wait names the approval", waits[0]?.approvalId === approvalId, waits[0]?.approvalId);
  check("the wait names the requestId", waits[0]?.requestId === REQUEST_ID, waits[0]?.requestId);
  check("the wait names the session", waits[0]?.session === "7", waits[0]?.session);
  check("the wait has a deadline", waits[0]?.deadline > Date.now(), `${waits[0]?.deadline}`);

  store.recordPaused({
    bot: "hermes",
    session: "7",
    requestId: REQUEST_ID,
    envelope: JSON.stringify(PAUSE),
  });
  check("a pause seen twice starts one wait", waits.length === 1, `${waits.length}`);
  check(
    "the pause seen twice is still one row",
    store.pending().length === 1,
    `${store.pending().length}`,
  );
}

// ---------------------------------------------------------------------------
// The delivery: one steer per approval, whichever path submits it.
// ---------------------------------------------------------------------------

{
  const submissions = [];
  const { store } = fresh({ submit: recorder(submissions) });
  store.recordPaused({
    bot: "hermes",
    session: "7",
    requestId: REQUEST_ID,
    envelope: JSON.stringify(PAUSE),
  });
  const approvalId = store.pending()[0].approvalId;

  const decided = await store.decide(approvalId, { action: "allow" }, recorder(submissions));
  check("the decision is recorded", decided?.status === "allowed", decided?.status);
  check("the decision steers at once", submissions.length === 1, `${submissions.length}`);

  const first = await store.deliver(approvalId);
  const second = await store.deliver(approvalId);
  check("a decided approval is delivered", first === "delivered", first);
  check("the delivery repeats", second === "delivered", second);
  check(
    "every delivery carries one operation id",
    submissions.every((submission) => submission.operationId === submissions[0].operationId),
    submissions.map((submission) => submission.operationId).join(" "),
  );
  check(
    "the operation id names the approval",
    submissions[0]?.operationId.includes(approvalId),
    submissions[0]?.operationId,
  );
  check(
    "the delivery steers the pausing session",
    submissions.at(-1)?.session === "7",
    submissions.at(-1)?.session,
  );
  check(
    "the delivery asks for the decided action",
    submissions.at(-1)?.input.includes('"action":"accept"'),
    submissions.at(-1)?.input,
  );
}

// ---------------------------------------------------------------------------
// The wait task: it delivers a decided approval and leaves an undecided one.
// ---------------------------------------------------------------------------

{
  const waits = [];
  const submissions = [];
  const { store } = fresh({
    startWait: (wait) => {
      waits.push(wait);
    },
    submit: recorder(submissions),
  });
  store.recordPaused({
    bot: "hermes",
    session: "7",
    requestId: REQUEST_ID,
    envelope: JSON.stringify(PAUSE),
  });
  const approvalId = store.pending()[0].approvalId;
  const wait = waits[0];

  const undecided = await drivePhase("deliver", {
    input: wait,
    checkpoint: { phase: "deliver", delivered: false },
    now: Date.now(),
  });
  check(
    "an undecided approval is not delivered",
    submissions.length === 0,
    `${submissions.length}`,
  );
  check(
    "the wait hands the poll over to its sleep",
    undecided.commits[0]?.checkpoint?.phase === "wait",
    JSON.stringify(undecided.commits[0]),
  );

  const now = Date.now();
  const slept = await drivePhase("wait", { input: wait, checkpoint: { phase: "wait" }, now });
  check(
    "the wait sleeps about half a minute",
    slept.sleeps[0]?.until === now + 30_000,
    `${slept.sleeps[0]?.until}`,
  );
  check(
    "the wait wakes to deliver",
    slept.sleeps[0]?.checkpoint?.phase === "deliver",
    JSON.stringify(slept.sleeps[0]?.checkpoint),
  );

  const capped = await drivePhase("wait", {
    input: { ...wait, deadline: now + 1_000 },
    checkpoint: { phase: "wait" },
    now,
  });
  check(
    "the wait sleeps no longer than its deadline",
    capped.sleeps[0]?.until === now + 1_000,
    `${capped.sleeps[0]?.until}`,
  );

  // The decision the HTTP path makes, and the steer that goes with it.
  await store.decide(approvalId, { action: "allow" }, recorder(submissions));
  check("the decision steers at once", submissions.length === 1, `${submissions.length}`);

  const delivery = await drivePhase("deliver", {
    input: wait,
    checkpoint: { phase: "deliver", delivered: false },
    now: Date.now(),
  });
  check(
    "the wait delivers the decided approval",
    submissions.length === 2,
    `${submissions.length}`,
  );
  check(
    "the delivery carries the operation id the decision used",
    submissions[1]?.operationId === submissions[0]?.operationId,
    `${submissions[1]?.operationId} vs ${submissions[0]?.operationId}`,
  );
  check(
    "the delivery asks for the decided action",
    submissions[1]?.input.includes('"action":"accept"'),
    submissions[1]?.input,
  );
  check(
    "the wait records the delivery",
    delivery.commits[0]?.checkpoint?.delivered === true,
    JSON.stringify(delivery.commits[0]),
  );

  const finished = await drivePhase("deliver", {
    input: wait,
    checkpoint: { phase: "deliver", delivered: true },
    now: Date.now(),
  });
  check(
    "the wait ends after the delivery",
    finished.commits[0]?.status === "terminal" &&
      finished.commits[0]?.outcome?.status === "completed",
    JSON.stringify(finished.commits[0]),
  );
  check(
    "the receipt names the operation id",
    finished.commits[0]?.outcome?.result?.operationId === submissions[1]?.operationId,
    JSON.stringify(finished.commits[0]?.outcome?.result),
  );
}

// ---------------------------------------------------------------------------
// The wait gives up when nobody decides it in time.
// ---------------------------------------------------------------------------

{
  const waits = [];
  const submissions = [];
  const { store } = fresh({
    startWait: (wait) => {
      waits.push(wait);
    },
    submit: recorder(submissions),
  });
  store.recordPaused({
    bot: "hermes",
    session: "7",
    requestId: REQUEST_ID,
    envelope: JSON.stringify(PAUSE),
  });
  const wait = waits[0];

  const past = await drivePhase("deliver", {
    input: wait,
    checkpoint: { phase: "deliver", delivered: false },
    now: wait.deadline + 1,
  });
  check(
    "the wait gives up past its deadline",
    past.commits[0]?.status === "terminal" && past.commits[0]?.outcome?.status === "failed",
    JSON.stringify(past.commits[0]),
  );
  check(
    "the wait delivers nothing past its deadline",
    submissions.length === 0,
    `${submissions.length}`,
  );

  const asleep = await drivePhase("wait", {
    input: wait,
    checkpoint: { phase: "wait" },
    now: wait.deadline + 1,
  });
  check(
    "the wait stops sleeping past its deadline",
    asleep.commits[0]?.status === "terminal" && asleep.commits[0]?.outcome?.status === "failed",
    JSON.stringify(asleep.commits[0]),
  );
  check(
    "the wait sleeps no more past its deadline",
    asleep.sleeps.length === 0,
    `${asleep.sleeps.length}`,
  );
}

// ---------------------------------------------------------------------------
// The same wait under a real Harness: the scheduler has to accept its phases.
// ---------------------------------------------------------------------------

{
  const submissions = [];
  const { store } = fresh({ submit: recorder(submissions) });
  store.recordPaused({
    bot: "hermes",
    session: "7",
    requestId: REQUEST_ID,
    envelope: JSON.stringify(PAUSE),
  });
  const approvalId = store.pending()[0].approvalId;
  await store.decide(approvalId, { action: "allow" }, recorder(submissions));

  // A harness of its own, over memory, on a clock the test moves by hand.
  let clock = 1_000_000;
  const registry = createRegistry();
  registry.install(defineExtension({ name: "mackbot-approvals", tasks: [ApprovalWait] }));
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models: createModels(),
      registry,
      now: () => clock,
      setTimer: (callback) => {
        const timer = setTimeout(callback, 0);
        return () => clearTimeout(timer);
      },
    },
    BACKGROUND_CONTEXT,
  );
  const root = await harness.root(BACKGROUND_CONTEXT);
  const taskId = await root.commit(
    (tx) =>
      tx.createTask(
        ApprovalWait,
        { approvalId, requestId: REQUEST_ID, session: "7", deadline: clock + 600_000 },
        { ownership: { kind: "conversation" }, background: true },
      ),
    BACKGROUND_CONTEXT,
  );

  /** The clock the wait sleeps until, once the harness has stored the sleep. */
  const slept = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const inspection = await harness.inspect(BACKGROUND_CONTEXT);
      const task = inspection.tasks.find((candidate) => candidate.record.id === taskId);
      if (task?.state.kind === "sleeping") return task.state.until;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return undefined;
  };

  harness.resume();
  const until = await slept();
  check("the wait sleeps until the next poll", until === clock + 30_000, `${until}`);

  clock += 30_000;
  harness.resume();
  const settled = await harness.waitForTask(taskId, BACKGROUND_CONTEXT);
  check(
    "the wait ends with the delivery it made",
    settled.state.outcome?.status === "completed",
    JSON.stringify(settled.state.outcome),
  );
  check("the wait delivered the approval", submissions.length === 2, `${submissions.length}`);
  check(
    "the delivery carries the operation id the decision used",
    submissions[1]?.operationId === submissions[0]?.operationId,
    `${submissions[1]?.operationId} vs ${submissions[0]?.operationId}`,
  );
  await harness.close(BACKGROUND_CONTEXT);
}

if (failures.length > 0) {
  console.error("approvals smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("approvals smoke passed");
process.exit(0);
