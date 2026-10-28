/**
 * Smoke test for registry-sync (src/registry-sync.ts).
 *
 * Run with: bun tests/registry-sync.smoke.mjs
 *
 * The claims this file has to break if they stop holding:
 *   1. A bot that declares `commitments` gets the extension installed.
 *   2. Re-running the sync replaces the installed extension in place: one
 *      entry, same position, and the newly passed object is the one resolved.
 *   3. A bot that does not declare it has it uninstalled, and the other
 *      extensions the harness installed are untouched.
 *   4. Syncing an already-correct registry changes nothing else.
 */
import { createRegistry, defineExtension } from "@earendil-works/pi-durable";

import { syncExtensions } from "../src/registry-sync.ts";

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
};

const bot = (commitments) => {
  const config = { model: "deepseek-v4-pro", systemPrompt: "You are Hermes." };
  if (commitments !== undefined) config.commitments = commitments;
  return config;
};

/** The host wiring that must never be re-installed by a sync. */
const host = defineExtension({ name: "mackbot-executor" });

/** Two objects with the same name: the roster's extension can be replaced. */
const first = defineExtension({ name: "mackbot-commitments" });
const second = defineExtension({ name: "mackbot-commitments" });

const names = (registry) =>
  registry
    .snapshot()
    .installed()
    .map((extension) => extension.name);

{
  const registry = createRegistry();
  registry.install(host);
  syncExtensions(registry, bot(true), { commitments: first });

  check(
    "an enabled bot installs the commitments extension",
    registry.snapshot().extension("mackbot-commitments") === first,
    names(registry).join(","),
  );
  check("the host wiring is still there", registry.snapshot().extension(host.name) === host);

  syncExtensions(registry, bot(true), { commitments: second });

  check(
    "re-running the sync keeps exactly one entry",
    names(registry).filter((name) => name === "mackbot-commitments").length === 1,
    names(registry).join(","),
  );
  check(
    "the replacement is in place, not appended",
    names(registry).join(",") === `${host.name},mackbot-commitments`,
    names(registry).join(","),
  );
  check(
    "the newly passed extension is the one resolved",
    registry.snapshot().extension("mackbot-commitments") === second,
    names(registry).join(","),
  );

  syncExtensions(registry, bot(false), { commitments: second });

  check(
    "a disabled bot uninstalls it",
    registry.snapshot().extension("mackbot-commitments") === undefined,
    names(registry).join(","),
  );
  check(
    "the other extensions survive the uninstall",
    registry.snapshot().extension(host.name) === host,
    names(registry).join(","),
  );

  // Disabling one that was never installed, and disabling it twice, are no-ops.
  syncExtensions(registry, bot(undefined), { commitments: second });
  check(
    "uninstalling an absent extension is a no-op",
    registry.snapshot().extension("mackbot-commitments") === undefined,
    names(registry).join(","),
  );
  check(
    "the host wiring is untouched",
    names(registry).join(",") === host.name,
    names(registry).join(","),
  );
}

if (failures.length > 0) {
  console.error(`\n${failures.length} registry-sync checks failed`);
  process.exit(1);
}
console.log("\nregistry-sync smoke passed");
