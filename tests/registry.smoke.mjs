/**
 * Smoke test for the roster's store and the write decision
 * (`src/registry-store.ts`, and the seed in `src/registry.ts`).
 *
 * Run with: bun tests/registry.smoke.mjs
 *
 * The store runs over `bun:sqlite` through the same seam a Durable Object's
 * SQLite storage has, so the SQL is the SQL. The Durable Object's own module
 * imports the `cloudflare:workers` builtin, which Bun cannot resolve, so this
 * re-execs with `tests/shims` on NODE_PATH — the same pattern the routes
 * smoke test uses.
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
const { durableStorage } = await import("./support/durable-sqlite.mjs");
const { createRegistryStore, decideWrite, readOrSeed } = await import("../src/registry-store.ts");
const { seedBots } = await import("../src/registry.ts");

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
};

const database = new Database(":memory:");
const storage = durableStorage(database);
const store = createRegistryStore(storage);

/**
 * The write the Durable Object makes: read, decide, write, all in one
 * transaction, so a refused write leaves the roster exactly as it was.
 */
const write = async (id, bot, mode) =>
  await storage.transaction(async () => {
    const current = await store.read();
    const decision = await decideWrite(current, id, bot, mode);
    if (!decision.ok) return decision;
    await store.write(id, bot);
    return decision;
  });

// ---------------------------------------------------------------------------
// The seed fills an empty registry.
// ---------------------------------------------------------------------------

const seeded = await readOrSeed(store, seedBots);
const seedSize = Object.keys(seedBots()).length;
check("the seed fills an empty registry", Object.keys(seeded).length === seedSize, `${seedSize}`);
check("the seed holds hermes", seeded.hermes?.model === "deepseek-v4-pro");
check(
  "the seed holds hermes's delegate",
  JSON.stringify(seeded.hermes?.delegatesTo) === JSON.stringify(["scribe"]),
);
check(
  "the seed is read once: a second read keeps the roster",
  JSON.stringify(await readOrSeed(store, seedBots)) === JSON.stringify(seeded),
);

// ---------------------------------------------------------------------------
// A write adds a bot, and a refused write changes nothing.
// ---------------------------------------------------------------------------

const scout = { model: "glm-5.3", systemPrompt: "You are Scout." };
const created = await write("scout", scout, "create");
check("a create is accepted", created.ok, created.ok ? "" : created.error);
const afterCreate = await store.read();
check("the created bot is in the roster", afterCreate.scout?.systemPrompt === "You are Scout.");

const unknownModel = { model: "no-such-model", systemPrompt: "x" };
const refusedModel = await write("ghost", unknownModel, "create");
check("an unknown model is refused", !refusedModel.ok && refusedModel.code === "invalid");
check(
  "the refusal carries the rule's own message",
  refusedModel.error?.includes("not in the OpenCode Go catalog") === true,
  refusedModel.error,
);

const dangling = { model: "glm-5.3", systemPrompt: "x", delegatesTo: ["nobody"] };
const refusedDelegate = await write("lonely", dangling, "create");
check("a dangling delegate is refused", !refusedDelegate.ok && refusedDelegate.code === "invalid");
check(
  "the refusal names the dangling target",
  refusedDelegate.error?.includes("not a declared bot") === true,
  refusedDelegate.error,
);

const afterRefusals = await store.read();
check(
  "a refused write leaves the roster exactly as it was",
  JSON.stringify(afterRefusals) === JSON.stringify(afterCreate),
);

// ---------------------------------------------------------------------------
// A create over an existing id, and a replace of an unknown one.
// ---------------------------------------------------------------------------

const exists = await write("hermes", { model: "glm-5.3", systemPrompt: "x" }, "create");
check("a create over an existing id is refused", !exists.ok && exists.code === "exists");
const unknown = await write("nobody", { model: "glm-5.3", systemPrompt: "x" }, "replace");
check("a replace of an unknown id is refused", !unknown.ok && unknown.code === "unknown");
check(
  "a refused write still leaves the roster as it was",
  JSON.stringify(await store.read()) === JSON.stringify(afterCreate),
);

const replaced = await write(
  "hermes",
  { model: "glm-5.3", systemPrompt: "A new prompt." },
  "replace",
);
check("a replace of a declared id is accepted", replaced.ok);
check(
  "the replaced bot carries the new prompt",
  (await store.read()).hermes?.systemPrompt === "A new prompt.",
);

// ---------------------------------------------------------------------------
// A row the Worker cannot read fails loudly.
// ---------------------------------------------------------------------------

database.exec("INSERT OR REPLACE INTO mackbot_bots (id, spec) VALUES ('broken', '{\"model\": 7}')");
let broken = null;
try {
  await store.read();
} catch (error) {
  broken = error;
}
check("a row that cannot be decoded fails loudly", broken !== null, String(broken));
check(
  "the failure names the bot whose row it was",
  String(broken?.message ?? broken).includes("broken"),
  String(broken?.message ?? broken),
);

if (failures.length > 0) {
  console.error("registry smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("registry smoke passed");
process.exit(0);
