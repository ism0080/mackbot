/**
 * memory — shared cross-bot memory as a pi extension.
 *
 * Cross-bot memory lives in the `memory` app on Executor (see plan.md, "Late
 * todo: cross-bot shared memory"). Pi Durable keeps memory per conversation, so
 * there is no built-in sharing across bot DOs; this extension is the seam that
 * gives each bot a stable, prompt-cache-friendly view of which scopes it can
 * read and write, and points it at the Executor memory app for the actual facts.
 *
 * Per-bot scopes come from `bots.json`:
 *
 *   "sharedMemory": { "read": ["homelab", "family"], "write": ["homelab"] }
 *
 * The section is *index only*: it never inlines recalled facts, so provider
 * prompt caches stay warm. Facts are fetched lazily through the Executor tools
 * (discover with `executor_search`, then `memory.recall` / `memory.remember` /
 * `memory.forget`), which is what keeps the tool surface fixed and cheap.
 *
 * Public API (what a bot's harness installs):
 *
 *   import { createSharedMemory } from "./memory.ts";
 *   const extension = createSharedMemory({
 *     env,
 *     scopes: { read: [...], write: [...] },
 *   });
 */

import type { Env } from "./index.ts";
import { defineExtension, section } from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";

/** Configuration for {@link createSharedMemory}. */
export type MemoryConfig = {
  readonly env: Env;
  readonly scopes: { readonly read: string[]; readonly write: string[] };
};

/** Build the `memory` index prompt section for one bot's readable/writable scopes. */
const buildMemorySection = (read: readonly string[], write: readonly string[]) =>
  [
    "Shared cross-bot memory (index). Facts live in the Executor `memory` app and are fetched on demand, not inlined here.",
    "",
    `Readable scopes: ${read.length > 0 ? read.join(", ") : "(none)"}`,
    `Writable scopes: ${write.length > 0 ? write.join(", ") : "(none)"}`,
    "",
    "Use executor_search to discover the memory app's tools (memory.recall, memory.remember, memory.forget), then executor_describe before the first call.",
    "Call memory.recall to read facts, scoped to a readable scope above.",
    "Call memory.remember to store a distilled fact, only into a writable scope above; never write to a scope not listed as writable.",
    "Call memory.forget to archive a fact. All rows carry provenance (which bot, which conversation, when).",
  ].join("\n");

/**
 * Build the shared-memory extension: one stable `memory` prompt section (index
 * only, scopes + instructions). No tools are wrapped here; reads/writes go
 * through the fixed Executor meta-tools so the tool surface never grows.
 */
export function createSharedMemory(config: MemoryConfig): Extension {
  const { read, write } = config.scopes;
  const memorySection = section("memory", () => buildMemorySection(read, write));
  return defineExtension({
    name: "shared-memory",
    sections: [memorySection],
  });
}