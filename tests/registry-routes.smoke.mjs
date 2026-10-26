/**
 * Smoke test for the registry's routes (src/index.ts): `GET /bots`,
 * `POST /bots`, `PUT /bots/:id` and `GET /models`.
 *
 * Run with: bun tests/registry-routes.smoke.mjs
 *
 * `src/index.ts` imports the `cloudflare:workers` builtin for `DurableObject`,
 * which Bun cannot resolve, so this re-execs with `tests/shims` on NODE_PATH —
 * the same pattern the routes smoke test uses. The `Bot` and `Registry`
 * bindings are faked; the front door, its bearer check, its body decoding and
 * its route matching are the real ones. The fake registry decides with the
 * real rules, so the refusals the routes answer are the refusals the Durable
 * Object would answer.
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
const { decideWrite } = await import("../src/registry-store.ts");

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
};

const TOKEN = "test-token";

const HERMES = {
  model: "deepseek-v4-pro",
  thinkingLevel: "high",
  systemPrompt: "You are Hermes.",
  delegatesTo: ["scribe"],
};
const SCRIBE = { model: "longcat-2.5-preview-free", systemPrompt: "You are Scribe." };

const bots = { hermes: HERMES, scribe: SCRIBE };

const registry = {
  roster: async () => ({ ...bots }),
  bot: async (id) => bots[id],
  put: async (id, bot, mode) => {
    const decision = await decideWrite(bots, id, bot, mode);
    if (decision.ok) bots[id] = bot;
    return decision;
  },
};

const env = {
  CHAT_BEARER_TOKEN: TOKEN,
  Bot: {
    getByName: () => ({
      transcript: async () => ({}),
      status: async () => ({}),
    }),
  },
  Registry: { getByName: () => registry },
};

const send = (path, init = {}) =>
  worker.fetch(
    new Request(`https://mackbot.test${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers },
    }),
    env,
  );

const post = (path, body) =>
  send(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const put = (path, body) =>
  send(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// An unauthenticated request is refused with JSON, not with a redirect.
// ---------------------------------------------------------------------------

{
  const response = await worker.fetch(new Request("https://mackbot.test/bots"), env);
  check("an unauthenticated roster is 401", response.status === 401, `${response.status}`);
  check(
    "the refusal is JSON",
    response.headers.get("content-type")?.startsWith("application/json") === true,
  );
  const body = await response.json();
  check("the refusal says why", body.error === "unauthorized", JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// GET /bots answers the roster.
// ---------------------------------------------------------------------------

{
  const response = await send("/bots");
  check("the roster is 200", response.status === 200, `${response.status}`);
  const body = await response.json();
  check("the roster carries every bot", Object.keys(body.bots).length === 2, JSON.stringify(body));
  check(
    "the roster carries a bot's configuration",
    body.bots.hermes?.systemPrompt === "You are Hermes.",
    JSON.stringify(body.bots.hermes),
  );
}

// ---------------------------------------------------------------------------
// GET /models answers the catalog.
// ---------------------------------------------------------------------------

{
  const response = await send("/models");
  check("the catalog is 200", response.status === 200, `${response.status}`);
  const body = await response.json();
  check(
    "the catalog carries a model's levels",
    JSON.stringify(body.models?.["deepseek-v4-pro"]) === JSON.stringify(["high", "max"]),
    JSON.stringify(body.models?.["deepseek-v4-pro"]),
  );
}

// ---------------------------------------------------------------------------
// POST /bots creates, and a body that does not decode is refused.
// ---------------------------------------------------------------------------

{
  const response = await post("/bots", {
    id: "scout",
    bot: { model: "glm-5.3", systemPrompt: "You are Scout." },
  });
  check("a create is 201", response.status === 201, `${response.status}`);
  const body = await response.json();
  check("the create answers the id", body.id === "scout", JSON.stringify(body));
  check(
    "the create answers the bot",
    body.bot?.systemPrompt === "You are Scout.",
    JSON.stringify(body),
  );
  check("the roster has the new bot", bots.scout?.systemPrompt === "You are Scout.");
}

{
  const response = await post("/bots", { id: "scout", bot: { model: "glm-5.3" } });
  check("a body that does not decode is 400", response.status === 400, `${response.status}`);
  const body = await response.json();
  check("the refusal names the body", body.error === "invalid request body", JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// A rule that refuses is a 400 with the rule's own message.
// ---------------------------------------------------------------------------

{
  const response = await post("/bots", {
    id: "ghost",
    bot: { model: "no-such-model", systemPrompt: "x" },
  });
  check("a refused bot is 400", response.status === 400, `${response.status}`);
  const body = await response.json();
  check(
    "the refusal carries the rule's own message",
    body.error?.includes("not in the OpenCode Go catalog") === true,
    JSON.stringify(body),
  );
  check("the refused bot was not written", bots.ghost === undefined);
}

// ---------------------------------------------------------------------------
// A create over an existing id is a 409; a replace of an unknown one is a 404.
// ---------------------------------------------------------------------------

{
  const response = await post("/bots", {
    id: "hermes",
    bot: { model: "glm-5.3", systemPrompt: "x" },
  });
  check("a create over an existing id is 409", response.status === 409, `${response.status}`);
  check(
    "the roster keeps the bot it had",
    bots.hermes?.systemPrompt === "You are Hermes.",
    JSON.stringify(bots.hermes),
  );
}

{
  const response = await put("/bots/nobody", { bot: { model: "glm-5.3", systemPrompt: "x" } });
  check("a replace of an unknown id is 404", response.status === 404, `${response.status}`);
}

// ---------------------------------------------------------------------------
// PUT /bots/:id replaces.
// ---------------------------------------------------------------------------

{
  const response = await put("/bots/hermes", {
    bot: { model: "deepseek-v4-pro", thinkingLevel: "high", systemPrompt: "A new prompt." },
  });
  check("a replace is 200", response.status === 200, `${response.status}`);
  const body = await response.json();
  check("the replace answers the id", body.id === "hermes", JSON.stringify(body));
  check(
    "the replace answers the new configuration",
    body.bot?.systemPrompt === "A new prompt.",
    JSON.stringify(body),
  );
  check(
    "the roster has the new prompt",
    bots.hermes?.systemPrompt === "A new prompt.",
    JSON.stringify(bots.hermes),
  );
}

{
  const response = await put("/bots/hermes", { bot: { model: "deepseek-v4-pro" } });
  check("a body that does not decode is 400", response.status === 400, `${response.status}`);
}

{
  const response = await send("/bots/hermes", { method: "DELETE" });
  check("a DELETE is 405", response.status === 405, `${response.status}`);
}

if (failures.length > 0) {
  console.error("registry-routes smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("registry-routes smoke passed");
process.exit(0);
