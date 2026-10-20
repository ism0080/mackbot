/**
 * Smoke test for the retry route (src/index.ts): `POST /retry/:bot`.
 *
 * Run with: bun tests/retry.smoke.mjs
 *
 * `src/index.ts` imports the `cloudflare:workers` builtin for `DurableObject`,
 * which Bun cannot resolve, so this re-execs with `tests/shims` on NODE_PATH —
 * the same pattern the abort and routes smoke tests use. The Bot binding is
 * faked; the front door, its bearer check, its body decoding and its route
 * matching are the real ones.
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
const calls = [];
const env = {
  CHAT_BEARER_TOKEN: TOKEN,
  Registry: registryBinding(),
  Bot: {
    getByName: (name) => ({
      retry: async (taskId) => {
        calls.push({ name, taskId });
        return { bot: name, taskId, retried: true };
      },
    }),
  },
};

const retry = (path, body, headers = {}) =>
  worker.fetch(
    new Request(`https://mackbot.test${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, ...headers },
      body,
    }),
    env,
  );

// ---------------------------------------------------------------------------
// The route is behind the front door's own gate.
// ---------------------------------------------------------------------------

{
  const response = await worker.fetch(
    new Request("https://mackbot.test/retry/hermes", { method: "POST" }),
    env,
  );
  check("an unauthenticated retry is 401", response.status === 401, `${response.status}`);
  check("the bot was not reached", calls.length === 0);
}

// ---------------------------------------------------------------------------
// POST /retry/:bot runs the task the body names.
// ---------------------------------------------------------------------------

{
  const response = await retry("/retry/hermes", JSON.stringify({ taskId: "7" }));
  check("a retry is 200", response.status === 200, `${response.status}`);
  const body = await response.json();
  check(
    "the result names the bot and the task",
    body.bot === "hermes" && body.taskId === "7" && body.retried === true,
    JSON.stringify(body),
  );
  check("the named task was retried", calls.at(-1)?.taskId === "7", JSON.stringify(calls.at(-1)));
}

// ---------------------------------------------------------------------------
// A bad request never reaches the bot.
// ---------------------------------------------------------------------------

{
  const response = await retry("/retry/nobody", JSON.stringify({ taskId: "7" }));
  check("an unknown bot is 404", response.status === 404, `${response.status}`);
}

{
  const before = calls.length;
  const response = await retry("/retry/hermes", JSON.stringify({ taskId: 7 }));
  check("a non-string task id is 400", response.status === 400, `${response.status}`);
  check("the bot was not reached", calls.length === before, `${calls.length - before}`);
}

{
  const response = await worker.fetch(
    new Request("https://mackbot.test/retry/hermes", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
    env,
  );
  check("a non-POST retry is 405", response.status === 405, `${response.status}`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} retry checks failed`);
  process.exit(1);
}
console.log("\nretry smoke passed");
