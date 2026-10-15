/**
 * Smoke test for the bots.json loader (src/bots.ts).
 *
 * Run with: bun tests/bots.smoke.mjs
 *
 * Exercises the pure decoder through `parseBotRegistry` so every guard can be
 * checked without a crafted bots.json on disk, then confirms the real bundled
 * registry still loads.
 */
const { loadBots, parseBotRegistry, resolveModelRef } = await import("../src/bots.ts");

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

err("missing systemPrompt", { a: { model: "deepseek-v4-pro" } }, 'missing "systemPrompt"');
err("missing model", { a: { systemPrompt: "x" } }, 'missing "model"');
err(
  "unknown model",
  { a: { model: "no-such-model", systemPrompt: "x" } },
  "not in the OpenCode Go catalog",
);
err(
  "object model bad provider",
  { a: { model: { provider: "anthropic", modelId: "claude" }, systemPrompt: "x" } },
  "is not supported",
);
ok("object model ok", {
  a: { model: { provider: "opencode-go", modelId: "glm-5.3" }, systemPrompt: "x" },
});
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
  'field "thinkingLevel" must be one of',
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

err(
  "sharedMemory missing write",
  { a: { model: "glm-5.3", systemPrompt: "x", sharedMemory: { read: ["s"] } } },
  'field "sharedMemory.write" is required',
);
err(
  "budgets negative",
  { a: { model: "glm-5.3", systemPrompt: "x", budgets: { tokens: -1 } } },
  'field "budgets.tokens" must be a non-negative number',
);
ok("sharedMemory and budgets ok", {
  a: {
    model: "glm-5.3",
    systemPrompt: "x",
    sharedMemory: { read: ["s"], write: ["s"] },
    budgets: { tokens: 10, usd: 1 },
  },
});

const opencodeRef = resolveModelRef({ model: "deepseek-v4-pro", systemPrompt: "x" });
if (opencodeRef.provider !== "opencode-go" || opencodeRef.id !== "deepseek-v4-pro") {
  failures.push(`resolveModelRef opencode: ${JSON.stringify(opencodeRef)}`);
}
const workersRef = resolveModelRef({ model: "@cf/meta/llama", systemPrompt: "x" });
if (workersRef.provider !== "cloudflare" || workersRef.id !== "@cf/meta/llama") {
  failures.push(`resolveModelRef workers-ai: ${JSON.stringify(workersRef)}`);
}

try {
  const bots = loadBots();
  for (const id of ["hermes", "scribe"]) {
    if (!Object.hasOwn(bots, id)) failures.push(`real registry missing "${id}"`);
  }
  const hermes = resolveModelRef(bots.hermes);
  if (hermes.provider !== "opencode-go" || hermes.id !== "deepseek-v4-pro") {
    failures.push(`hermes model ref wrong: ${JSON.stringify(hermes)}`);
  }
} catch (error) {
  failures.push(`loadBots threw: ${error?.message ?? error}`);
}

if (failures.length > 0) {
  console.error("bots smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("bots smoke passed");
process.exit(0);
