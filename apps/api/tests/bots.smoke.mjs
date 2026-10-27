/**
 * Smoke test for the bot registry's rules (src/bots.ts).
 *
 * Run with: bun tests/bots.smoke.mjs
 *
 * Exercises the pure decoder through `parseBotRegistry` so every guard can be
 * checked without a crafted registry on disk, then confirms the bundled seed
 * file still decodes.
 */
import { readFileSync } from "node:fs";

const { parseBotRegistry, resolveModelRef } = await import("../src/bots.ts");

const failures = [];

const ok = (label, raw) => {
  const result = parseBotRegistry(raw);
  if (!result.ok) failures.push(`${label}: expected ok, got error: ${result.error}`);
  return result;
};

const err = (label, raw, needle) => {
  const result = parseBotRegistry(raw);
  if (result.ok) {
    failures.push(`${label}: expected an error, got ok`);
    return;
  }
  if (!result.error.includes(needle)) {
    failures.push(`${label}: error "${result.error}" does not include "${needle}"`);
  }
};

err("non-object registry", [], "keyed by bot id");
err("empty registry", {}, "the registry is empty");

err("missing systemPrompt", { a: { model: "deepseek-v4-pro" } }, "Missing key");
err("missing model", { a: { systemPrompt: "x" } }, "Missing key");
err("blank systemPrompt", { a: { model: "deepseek-v4-pro", systemPrompt: "  " } }, "systemPrompt");
err(
  "unknown model",
  { a: { model: "no-such-model", systemPrompt: "x" } },
  "not in the OpenCode Go catalog",
);
// The model is one id now: an object is not a model the shape can carry.
err(
  "object model",
  { a: { model: { provider: "opencode-go", modelId: "glm-5.3" }, systemPrompt: "x" } },
  "Expected string",
);
ok("catalog model ok", { a: { model: "glm-5.3", systemPrompt: "x" } });
ok("workers-ai model ok", { a: { model: "@cf/meta/llama-3.1-8b-instruct", systemPrompt: "x" } });

ok("valid thinking level", {
  a: { model: "deepseek-v4-pro", thinkingLevel: "high", systemPrompt: "x" },
});
err(
  "thinking level not on model",
  { a: { model: "deepseek-v4-pro", thinkingLevel: "low", systemPrompt: "x" } },
  "is not supported by",
);
err(
  "thinking level unknown",
  { a: { model: "glm-5.3", thinkingLevel: "extreme", systemPrompt: "x" } },
  "Expected",
);
err(
  "thinking level on variant-less model",
  { a: { model: "longcat-2.5-preview-free", thinkingLevel: "low", systemPrompt: "x" } },
  "has no thinking variants",
);

err(
  "delegatesTo unknown target",
  { a: { model: "glm-5.3", systemPrompt: "x", delegatesTo: ["ghost"] } },
  "not a declared bot",
);
err(
  "delegatesTo self",
  { a: { model: "glm-5.3", systemPrompt: "x", delegatesTo: ["a"] } },
  "delegatesTo itself",
);
ok("delegatesTo declared", {
  a: { model: "glm-5.3", systemPrompt: "x", delegatesTo: ["b"] },
  b: { model: "glm-5.3", systemPrompt: "y" },
});

const opencodeRef = resolveModelRef({ model: "deepseek-v4-pro", systemPrompt: "x" });
if (opencodeRef.provider !== "opencode-go" || opencodeRef.id !== "deepseek-v4-pro") {
  failures.push(`resolveModelRef opencode: ${JSON.stringify(opencodeRef)}`);
}
const workersRef = resolveModelRef({ model: "@cf/meta/llama", systemPrompt: "x" });
if (workersRef.provider !== "cloudflare" || workersRef.id !== "@cf/meta/llama") {
  failures.push(`resolveModelRef workers-ai: ${JSON.stringify(workersRef)}`);
}

// The bundled file is the registry's seed, so it has to decode.
try {
  const raw = JSON.parse(readFileSync(new URL("../bots.json", import.meta.url), "utf8"));
  const seeded = parseBotRegistry(raw);
  if (!seeded.ok) {
    failures.push(`the bundled seed does not decode: ${seeded.error}`);
  } else {
    for (const id of ["hermes", "scribe"]) {
      if (!Object.hasOwn(seeded.bots, id)) failures.push(`the bundled seed is missing "${id}"`);
    }
    const hermes = resolveModelRef(seeded.bots.hermes);
    if (hermes.provider !== "opencode-go" || hermes.id !== "deepseek-v4-pro") {
      failures.push(`hermes model ref wrong: ${JSON.stringify(hermes)}`);
    }
  }
} catch (error) {
  failures.push(`the bundled seed could not be read: ${error?.message ?? error}`);
}

if (failures.length > 0) {
  console.error("bots smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("bots smoke passed");
process.exit(0);
