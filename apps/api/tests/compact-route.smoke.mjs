/**
 * Smoke test for the compaction route (src/index.ts): `POST /compact/:bot`.
 *
 * Run with: bun tests/compact-route.smoke.mjs
 *
 * `src/index.ts` imports the `cloudflare:workers` builtin for `DurableObject`,
 * which Bun cannot resolve, so this re-execs under the shim in
 * `tests/support/workers-shim.mjs` - the same pattern the retry and abort smoke
 * tests use. The Bot binding is faked; the contract's schema, the front door's
 * bearer and CSRF checks, its body decoding and its route matching are real.
 *
 * The claims this file has to break if they stop holding:
 *   1. The request schema accepts an empty body, instructions alone, and a
 *      session alone.
 *   2. It rejects blank or non-string instructions, and a non-string session.
 *   3. The route refuses an unknown bot and an unauthenticated request, and
 *      never reaches the bot in either case.
 *   4. A valid request reaches the bot and answers `{ bot, taskId }`.
 */
import { withWorkersShim } from "./support/workers-shim.mjs";

withWorkersShim(import.meta.url);

const worker = (await import("../src/index.ts")).default;
const { registryBinding } = await import("./support/registry.mjs");
const { CompactRequestSchema } = await import("@mackbot/contract");

const Schema = await import("effect/Schema");

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
};

/** Decode a body the way the route does: JSON text, then the contract schema. */
const decode = (body) =>
  Schema.decodeUnknownOption(Schema.fromJsonString(CompactRequestSchema))(body);

// ---------------------------------------------------------------------------
// The request schema.
// ---------------------------------------------------------------------------

{
  const empty = decode("{}");
  check("an empty body decodes", empty._tag === "Some", JSON.stringify(empty));

  const instructions = decode(JSON.stringify({ instructions: "Keep the failing test names" }));
  check(
    "instructions alone decode",
    instructions._tag === "Some" &&
      instructions.value.instructions === "Keep the failing test names" &&
      instructions.value.session === undefined,
    JSON.stringify(instructions),
  );

  const session = decode(JSON.stringify({ session: "7" }));
  check(
    "a session alone decodes",
    session._tag === "Some" && session.value.session === "7",
    JSON.stringify(session),
  );

  const both = decode(JSON.stringify({ session: "7", instructions: "Summarize the build" }));
  check(
    "both fields decode together",
    both._tag === "Some" &&
      both.value.session === "7" &&
      both.value.instructions === "Summarize the build",
    JSON.stringify(both),
  );

  for (const [label, body] of [
    ["a blank instructions", JSON.stringify({ instructions: "   " })],
    ["an empty instructions", JSON.stringify({ instructions: "" })],
    ["a non-string instructions", JSON.stringify({ instructions: 7 })],
    ["a non-string session", JSON.stringify({ session: 7 })],
    ["a non-JSON body", "not json"],
  ]) {
    const decoded = decode(body);
    check(`${label} is rejected`, decoded._tag === "None", JSON.stringify(decoded));
  }
}

// ---------------------------------------------------------------------------
// The route.
// ---------------------------------------------------------------------------

const TOKEN = "test-token";
const calls = [];
const env = {
  CHAT_BEARER_TOKEN: TOKEN,
  Registry: registryBinding(),
  Bot: {
    getByName: (name) => ({
      compact: async (session, instructions) => {
        calls.push({ name, session, instructions });
        return { bot: name, taskId: "12" };
      },
    }),
  },
};

const compact = (path, body, headers = {}) =>
  worker.fetch(
    new Request(`https://mackbot.test${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, ...headers },
      body,
    }),
    env,
  );

{
  const response = await worker.fetch(
    new Request("https://mackbot.test/compact/hermes", { method: "POST" }),
    env,
  );
  check("an unauthenticated compaction is 401", response.status === 401, `${response.status}`);
  check("the bot was not reached", calls.length === 0);
}

{
  const response = await compact(
    "/compact/hermes",
    JSON.stringify({ session: "7", instructions: "Keep the failing test names" }),
  );
  check("a compaction is 200", response.status === 200, `${response.status}`);
  const body = await response.json();
  check(
    "the answer names the bot and the compaction task",
    body.bot === "hermes" && body.taskId === "12",
    JSON.stringify(body),
  );
  check(
    "the bot was asked to compact the named session",
    calls.at(-1)?.session === "7" && calls.at(-1)?.instructions === "Keep the failing test names",
    JSON.stringify(calls.at(-1)),
  );
}

{
  const response = await compact("/compact/hermes", "");
  check("an empty body is a request, not a bad one", response.status === 200, `${response.status}`);
  check(
    "an empty body compacts with no session and no instructions",
    calls.at(-1)?.session === undefined && calls.at(-1)?.instructions === undefined,
    JSON.stringify(calls.at(-1)),
  );
}

{
  const response = await compact("/compact/nobody", JSON.stringify({}));
  check("an unknown bot is 404", response.status === 404, `${response.status}`);
}

{
  const before = calls.length;
  const response = await compact("/compact/hermes", JSON.stringify({ instructions: "" }));
  check("a blank instructions body is 400", response.status === 400, `${response.status}`);
  check("the bot was not reached", calls.length === before, `${calls.length - before}`);
}

{
  const response = await worker.fetch(
    new Request("https://mackbot.test/compact/hermes", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
    env,
  );
  check("a non-POST compaction is 405", response.status === 405, `${response.status}`);
}

{
  // A cookie-authenticated mutation needs the CSRF header, like every other one.
  const { issueSession, SESSION_COOKIE } = await import("../src/session.ts");
  const { runPromise } = await import("effect/Effect");
  const cookie = await runPromise(issueSession(TOKEN, Date.now()));
  const headers = { Authorization: "", Cookie: `${SESSION_COOKIE}=${cookie}` };

  const refused = await compact("/compact/hermes", JSON.stringify({}), headers);
  check(
    "a cookie POST without the CSRF header is 403",
    refused.status === 403,
    `${refused.status}`,
  );

  const allowed = await compact("/compact/hermes", JSON.stringify({}), {
    ...headers,
    Origin: "https://mackbot.test",
    "X-Mackbot-CSRF": "1",
  });
  check(
    "a cookie POST with the CSRF proof is accepted",
    allowed.status === 200,
    `${allowed.status}`,
  );
}

if (failures.length > 0) {
  console.error(`\n${failures.length} compact-route checks failed`);
  process.exit(1);
}
console.log("\ncompact-route smoke passed");
