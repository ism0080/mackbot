/**
 * Smoke test for the Worker front door (src/index.ts): `GET /transcript/:bot`
 * and `GET /status`.
 *
 * Run with: bun tests/routes.smoke.mjs
 *
 * `src/index.ts` imports the `cloudflare:workers` builtin for `DurableObject`,
 * which Bun cannot resolve, so this re-execs with `tests/shims` on NODE_PATH —
 * the same pattern the streams smoke test uses. The Bot binding is faked; the
 * front door, its bearer check, its query decoding and its route matching are
 * the real ones.
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

const worker = (await import("../src/index.ts")).default;
const { registryBinding } = await import("./support/registry.mjs");

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
};

const TOKEN = "test-token";
const PAGE = {
  session: "1",
  entries: [
    { id: 6, kind: "pi.user", role: "user", text: "do the thing", at: 1_000, origin: "http" },
  ],
  nextBefore: 6,
  stream: { stream: "feed:1:1", generation: 1, cursor: 3, state: "streaming" },
};
const STATUS_VIEW = {
  id: "hermes",
  model: { provider: "opencode-go", id: "deepseek-v4-pro" },
  thinkingLevel: "high",
  busy: true,
  pending: [{ operationId: "http:a", origin: "http", status: "running" }],
  usage: { inputTokens: 10, outputTokens: 4, exchanges: 1 },
  approvals: [
    {
      approvalId: "apr-1",
      bot: "hermes",
      toolPath: "botmail.send",
      summary: "Send?",
      status: "pending",
      requestedAt: 1_000,
    },
  ],
  activeRun: {
    ordinal: 1,
    inputs: ["do the thing"],
    startedAt: 1_000,
    session: "1",
    stream: { stream: "feed:1:1", generation: 1, cursor: 3, state: "streaming" },
  },
};

const queries = [];
const env = {
  CHAT_BEARER_TOKEN: TOKEN,
  Registry: registryBinding(),
  Bot: {
    getByName: () => ({
      transcript: async (query) => {
        queries.push(query);
        return PAGE;
      },
      status: async () => STATUS_VIEW,
    }),
  },
};

const get = (path, headers = {}) =>
  worker.fetch(new Request(`https://mackbot.test${path}`, { headers }), env);

// ---------------------------------------------------------------------------
// Authorization is still the front door's, and only the front door's.
// ---------------------------------------------------------------------------

{
  const unauthorized = await get("/transcript/hermes");
  check(
    "an unauthenticated transcript is 401",
    unauthorized.status === 401,
    `${unauthorized.status}`,
  );
  check("the transcript was not reached", queries.length === 0);
}

// ---------------------------------------------------------------------------
// GET /transcript/:bot decodes the query and returns the DO's page verbatim.
// ---------------------------------------------------------------------------

{
  const response = await get("/transcript/hermes?thread=invoices&before=40&limit=5", {
    Authorization: `Bearer ${TOKEN}`,
  });
  check("an authenticated transcript is 200", response.status === 200, `${response.status}`);
  check(
    "the transcript is JSON",
    response.headers.get("content-type")?.startsWith("application/json") === true,
  );
  check(
    "the query decodes to a typed page request",
    JSON.stringify(queries[0]) === JSON.stringify({ thread: "invoices", before: 40, limit: 5 }),
    JSON.stringify(queries[0]),
  );
  const page = await response.json();
  check("the page is returned verbatim", JSON.stringify(page) === JSON.stringify(PAGE));
  check("the page carries the entry's time", page.entries[0].at === 1_000, `${page.entries[0].at}`);
  check("the page carries the next cursor", page.nextBefore === 6, `${page.nextBefore}`);
}

{
  const response = await get("/transcript/hermes", { Authorization: `Bearer ${TOKEN}` });
  await response.json();
  check(
    "an empty query is an empty request",
    JSON.stringify(queries.at(-1)) === "{}",
    JSON.stringify(queries.at(-1)),
  );
}

{
  const response = await get("/transcript/hermes?limit=oops", { Authorization: `Bearer ${TOKEN}` });
  check("a non-numeric limit is 400", response.status === 400, `${response.status}`);
}

{
  const response = await get("/transcript/hermes?limit=0", { Authorization: `Bearer ${TOKEN}` });
  check("an out-of-range limit is 400", response.status === 400, `${response.status}`);
}

{
  const response = await get("/transcript/nobody", { Authorization: `Bearer ${TOKEN}` });
  check("an unknown bot is 404", response.status === 404, `${response.status}`);
}

{
  const response = await worker.fetch(
    new Request("https://mackbot.test/transcript/hermes", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
    env,
  );
  check("a non-GET transcript is 405", response.status === 405, `${response.status}`);
}

// ---------------------------------------------------------------------------
// GET /status returns the projected views, keyed by bot id.
// ---------------------------------------------------------------------------

{
  const response = await get("/status", { Authorization: `Bearer ${TOKEN}` });
  check("status is 200", response.status === 200, `${response.status}`);
  const body = await response.json();
  const hermes = body.bots.hermes;
  check(
    "status projects a pending approval",
    hermes?.approvals[0]?.status === "pending",
    JSON.stringify(hermes?.approvals),
  );
  check(
    "status projects the active run",
    hermes?.activeRun?.ordinal === 1,
    `${hermes?.activeRun?.ordinal}`,
  );
  check(
    "status projects usage as a view",
    hermes?.usage.inputTokens === 10,
    JSON.stringify(hermes?.usage),
  );
  check(
    "status reports no errors",
    Object.keys(body.errors).length === 0,
    JSON.stringify(body.errors),
  );
}

if (failures.length > 0) {
  console.error("routes smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("routes smoke passed");
process.exit(0);
