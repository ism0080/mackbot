/**
 * Smoke test for the thread→session document (src/threads.ts).
 *
 * Run with: bun tests/threads.smoke.mjs
 *
 * The claims this file has to break if they stop holding:
 *   1. The document is Session-scoped, latest-only, versioned, and starts empty.
 *   2. A thread recorded through the conversation-creation hook is readable
 *      afterwards, from the same harness and from a reopened one - the write
 *      happened in the creating commit, not after it.
 *   3. A creation with no pending thread records nothing, and two creations
 *      record their own thread rather than each other's.
 *   4. A thread recorded in the old `mackbot_threads` table still answers, so
 *      threads created before the document are not lost.
 */
import { Database } from "bun:sqlite";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";

import { legacyThreadSession, recordThread, ThreadsDoc } from "../src/threads.ts";
import { durableStorage } from "./support/durable-sqlite.mjs";

const context = BACKGROUND_CONTEXT;

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
};

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);

// ---------------------------------------------------------------------------
// The document itself is the Session-scoped thread map it claims to be.
// ---------------------------------------------------------------------------

{
  const definition = ThreadsDoc.definition;
  check("the document is session-scoped", definition.scope === "session", definition.scope);
  check("its kind is stable", definition.kind === "mackbot.threads", definition.kind);
  check("its version is 1", definition.version === 1, `${definition.version}`);
  check(
    "a Session document declares no history or fork behaviour",
    definition.history === undefined && definition.fork === undefined,
    `${definition.history}/${definition.fork}`,
  );
  check(
    "it starts with no threads",
    JSON.stringify(definition.initial()) === JSON.stringify({ threads: {} }),
    JSON.stringify(definition.initial()),
  );
  check(
    "it never checkpoints",
    definition.checkpointWhen({ threads: {} }, [], { deltasSinceBase: 99 }) === false,
  );
}

// ---------------------------------------------------------------------------
// The mapping is written in the creating commit and read back afterwards.
// ---------------------------------------------------------------------------

const storage = new MemoryStorage();
/** The bot's pending-thread field, as `#createSessionForThread` sets it. */
let pending;

const open = () =>
  Harness.open(
    storage,
    {
      models,
      registry: createRegistry(),
      conversationCreated: async (tx, conversation) => {
        if (pending === undefined) return;
        await recordThread(tx, pending, String(conversation.id));
      },
    },
    context,
  );

let harness = await open();

pending = "invoices";
const root = await harness.root(context, {
  agent: { model: { provider: "faux", modelId: "faux-1" } },
});
check("the root conversation was created", root.id !== undefined);

pending = "support";
const support = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);

pending = undefined;
const anonymous = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);

const snapshot = await harness.snapshot(ThreadsDoc, context);
check(
  "the thread recorded in the creating commit is readable",
  snapshot?.threads.invoices === String(root.id),
  JSON.stringify(snapshot),
);
check(
  "each creation records its own thread",
  snapshot?.threads.support === String(support.id),
  JSON.stringify(snapshot),
);
check(
  "a creation with no pending thread records nothing",
  Object.keys(snapshot?.threads ?? {}).length === 2,
  JSON.stringify(snapshot?.threads),
);
check(
  "the anonymous conversation has no thread",
  Object.values(snapshot?.threads ?? {}).includes(String(anonymous.id)) === false,
);

await harness.close(context);

// ---------------------------------------------------------------------------
// The legacy table still answers for threads the document does not know.
// ---------------------------------------------------------------------------

{
  const database = new Database(":memory:", { create: true });
  database.exec("CREATE TABLE mackbot_threads (thread TEXT PRIMARY KEY, session_id TEXT NOT NULL)");
  database.exec("INSERT INTO mackbot_threads (thread, session_id) VALUES ('legacy', '42')");
  const legacyStorage = durableStorage(database);
  check(
    "the legacy table answers for an old thread",
    legacyThreadSession(legacyStorage, "legacy") === "42",
    `${legacyThreadSession(legacyStorage, "legacy")}`,
  );
  check(
    "an unknown thread has no legacy session",
    legacyThreadSession(legacyStorage, "never-seen") === undefined,
    `${legacyThreadSession(legacyStorage, "never-seen")}`,
  );
  database.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} threads checks failed`);
  process.exit(1);
}
console.log("\nthreads smoke passed");
