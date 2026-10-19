/**
 * Smoke test for the stop route (src/index.ts): `POST /abort/:bot`.
 *
 * Run with: bun tests/abort.smoke.mjs
 *
 * `src/index.ts` imports the `cloudflare:workers` builtin for `DurableObject`,
 * which Bun cannot resolve, so this re-execs with `tests/shims` on NODE_PATH —
 * the same pattern the routes smoke test uses. The Bot binding is faked; the
 * front door, its bearer check, its body decoding and its route matching are
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

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
};

const TOKEN = "test-token";
const calls = [];
const env = {
  CHAT_BEARER_TOKEN: TOKEN,
  Bot: {
    getByName: (name) => ({
      abort: async (session) => {
        calls.push({ name, session });
        return { bot: name, session: session ?? "1", aborted: true };
      },
    }),
  },
};

const stop = (path, headers = {}) =>
  worker.fetch(
    new Request(`https://mackbot.test${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, ...headers },
    }),
    env,
  );

const stopWith = (path, body, headers = {}) =>
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
    new Request("https://mackbot.test/abort/hermes", { method: "POST" }),
    env,
  );
  check("an unauthenticated stop is 401", response.status === 401, `${response.status}`);
  check("the bot was not reached", calls.length === 0);
}

// ---------------------------------------------------------------------------
// POST /abort/:bot stops the session the body names, or the root session.
// ---------------------------------------------------------------------------

{
  const response = await stop("/abort/hermes");
  check("a stop is 200", response.status === 200, `${response.status}`);
  const body = await response.json();
  check("the result names the bot and the session", body.bot === "hermes" && body.session === "1", JSON.stringify(body));
  check("the result says what it stopped", body.aborted === true, JSON.stringify(body));
  check("the root session was stopped", calls.at(-1)?.session === undefined, JSON.stringify(calls.at(-1)));
}

{
  const response = await stopWith("/abort/hermes", JSON.stringify({ session: "7" }));
  check("a stop with a session is 200", response.status === 200, `${response.status}`);
  check("the named session was stopped", calls.at(-1)?.session === "7", JSON.stringify(calls.at(-1)));
}

// ---------------------------------------------------------------------------
// A bad request never reaches the bot.
// ---------------------------------------------------------------------------

{
  const response = await stop("/abort/nobody");
  check("an unknown bot is 404", response.status === 404, `${response.status}`);
}

{
  const before = calls.length;
  const response = await stopWith("/abort/hermes", JSON.stringify({ session: 7 }));
  check("a non-string session is 400", response.status === 400, `${response.status}`);
  check("the bot was not reached", calls.length === before, `${calls.length - before}`);
}

{
  const response = await worker.fetch(
    new Request("https://mackbot.test/abort/hermes", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
    env,
  );
  check("a non-POST stop is 405", response.status === 405, `${response.status}`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} abort checks failed`);
  process.exit(1);
}
console.log("\nabort smoke passed");
