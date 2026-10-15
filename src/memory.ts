/**
 * memory — shared cross-bot memory as a pi extension.
 */

import { defineExtension, section } from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import { Schema } from "effect";

/** Configuration for {@link createSharedMemory}. */
export const MemoryScopesSchema = Schema.Struct({
  read: Schema.Array(Schema.String),
  write: Schema.Array(Schema.String),
});

export type MemoryScopes = Schema.Schema.Type<typeof MemoryScopesSchema>;

export type MemoryConfig = {
  readonly scopes: MemoryScopes;
};

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

export function createSharedMemory(config: MemoryConfig): Extension {
  const scopes = Schema.decodeUnknownSync(MemoryScopesSchema)(config.scopes);
  const { read, write } = scopes;
  const memorySection = section("memory", () => buildMemorySection(read, write));
  return defineExtension({
    name: "shared-memory",
    sections: [memorySection],
  });
}
