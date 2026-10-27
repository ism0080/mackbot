/**
 * Smoke test for the Durable Object storage path (src/ does not own it, but
 * production does).
 *
 * Run with: bun tests/durable-storage.smoke.mjs
 *
 * Everything else in this suite runs against memory or against mackbot's own
 * tables. This one opens pi's real SQLite storage over a Durable Object's
 * SQLite, which is the path a deployed bot takes: the storage migrates its
 * schema on open, commits a conversation's entries and tasks, and reopens to
 * find them again.
 *
 * The Durable Object's storage is stood in for by bun:sqlite behind the same
 * shape pi's adapter uses; `tests/support/durable-sqlite.mjs` builds it.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";

import { durableStorage } from "./support/durable-sqlite.mjs";

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
};

const directory = mkdtempSync(join(tmpdir(), "mackbot-durable-"));
const path = join(directory, "session.sqlite");

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage("Stored durably.")]);

const context = BACKGROUND_CONTEXT;

const open = async () => {
  const database = new Database(path, { create: true });
  const storage = await openDurableObjectSqliteStorage(durableStorage(database), {
    prefix: "pi_",
  });
  const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
  return { harness, database };
};

const { harness, database } = await open();
const root = await harness.root(context, {
  agent: { model: { provider: "faux", modelId: "faux-1" } },
});

const settled = await (
  await root.submit({ type: "input", content: "Remember this." }, context)
).wait(context);
check("the conversation was answered", settled.status === "done", settled.status);

const entries = await root.entries({}, 20, undefined, context);
check(
  "the input and the answer are stored",
  entries.items.length >= 2,
  `${entries.items.length} entries`,
);

const tables = database
  .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pi_%'")
  .all()
  .map((row) => row.name);
check("pi's tables exist under the prefix", tables.length > 0, tables.join(","));

// The schema version is the one-way door: pi migrates a storage to version 2
// on open, and a version 2 database cannot be opened by an earlier release.
const schema = database.query("SELECT version FROM pi_durable_schema WHERE singleton = 1").get();
check("the storage migrated to pi's current schema", schema?.version === 2, JSON.stringify(schema));

await harness.close(context);
database.close();

// A second process over the same file finds the same conversation.
const reopened = new Database(path);
const reopenedTables = reopened
  .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pi_%'")
  .all()
  .map((row) => row.name);
check("the schema survives the reopen", reopenedTables.length > 0, reopenedTables.join(","));
reopened.close();

const { harness: second, database: secondDatabase } = await open();
const secondRoot = await second.root(context);
const secondEntries = await secondRoot.entries({}, 20, undefined, context);
check(
  "the conversation survives the reopen",
  secondEntries.items.length >= 2,
  `${secondEntries.items.length} entries`,
);
await second.close(context);
secondDatabase.close();

rmSync(directory, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n${failures.length} durable storage checks failed`);
  process.exit(1);
}
console.log("\ndurable storage smoke passed");
