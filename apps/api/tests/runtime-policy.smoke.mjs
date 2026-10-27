/**
 * Smoke test for the per-bot run policy (src/runtime-policy.ts) and for the
 * `runtime` and `commitments` fields of the registry decoder (src/bots.ts).
 *
 * Run with: bun tests/runtime-policy.smoke.mjs
 *
 * Pure logic: checks the policy derived from a bot's own declaration and the
 * decoder's guards through `parseBotRegistry`, so no crafted registry on disk
 * is needed. No credentials required.
 */
import { readFileSync } from "node:fs";

const { settingsFor } = await import("../src/runtime-policy.ts");
const { parseBotRegistry } = await import("../src/bots.ts");

const failures = [];

const expect = (label, actual, expected) => {
  const same = actual === expected;
  if (!same) failures.push(`${label}: expected ${expected}, got ${actual}`);
  console.log(
    `  ${same ? "ok  " : "FAIL"} ${label}${same ? "" : ` (expected ${expected}, got ${actual})`}`,
  );
};

const bot = (extra) => ({ model: "deepseek-v4-pro", systemPrompt: "x", ...extra });

// A bot that declares no runtime runs on the documented defaults.
const defaults = settingsFor(bot());
expect("default partial interval", defaults.progress.partialIntervalMs, 1000);
expect("default output interval", defaults.progress.outputIntervalMs, 1000);
expect("default compaction enabled", defaults.compaction.enabled, true);
expect("default reserve tokens", defaults.compaction.reserveTokens, 16384);
expect("default keep recent tokens", defaults.compaction.keepRecentTokens, 20000);
expect("default background tokens", defaults.compaction.backgroundTokens, 32768);
expect("default max retries", defaults.retry.maxRetries, 3);
expect("default tool execution", defaults.toolExecution, "parallel");
expect("default context retention", defaults.contextRetentionMs, 60_000);
expect("default document retention", defaults.documentRetentionMs, 60_000);

// A known context window scales the compaction thresholds and derives the reserve.
const sized = settingsFor(bot({ runtime: { contextWindow: 100_000 } }));
expect("sized reserve tokens", sized.compaction.reserveTokens, 12_000);
expect("sized keep recent tokens", sized.compaction.keepRecentTokens, 15_000);
expect("sized background tokens", sized.compaction.backgroundTokens, 25_000);
expect("sized compaction enabled", sized.compaction.enabled, true);

// An explicit reserve wins over the derived one, with or without a window.
const explicit = settingsFor(bot({ runtime: { contextWindow: 100_000, reserveTokens: 4_000 } }));
expect("explicit reserve wins over derived", explicit.compaction.reserveTokens, 4_000);
expect("explicit reserve keeps scaled keep recent", explicit.compaction.keepRecentTokens, 15_000);
const explicitNoWindow = settingsFor(bot({ runtime: { reserveTokens: 4_000 } }));
expect("explicit reserve without a window", explicitNoWindow.compaction.reserveTokens, 4_000);
expect(
  "explicit reserve without a window keeps default keep recent",
  explicitNoWindow.compaction.keepRecentTokens,
  20_000,
);
expect(
  "explicit reserve without a window keeps default background",
  explicitNoWindow.compaction.backgroundTokens,
  32_768,
);

// Tool execution and retries come from the declaration.
expect(
  "parallel tools false is sequential",
  settingsFor(bot({ runtime: { parallelTools: false } })).toolExecution,
  "sequential",
);
expect(
  "parallel tools true is parallel",
  settingsFor(bot({ runtime: { parallelTools: true } })).toolExecution,
  "parallel",
);
expect(
  "no parallel tools is parallel",
  settingsFor(bot({ runtime: {} })).toolExecution,
  "parallel",
);
expect(
  "max retries carried through",
  settingsFor(bot({ runtime: { maxRetries: 7 } })).retry.maxRetries,
  7,
);
expect("max retries default", settingsFor(bot({ runtime: {} })).retry.maxRetries, 3);

// The decoder accepts a runtime block and a commitments flag.
const accepted = parseBotRegistry({
  a: {
    model: "glm-5.3",
    systemPrompt: "x",
    runtime: {
      contextWindow: 100_000,
      reserveTokens: 4_000,
      maxRetries: 5,
      parallelTools: false,
    },
    commitments: true,
  },
});
if (!accepted.ok) {
  failures.push(`valid runtime block rejected: ${accepted.error}`);
  console.log(`  FAIL valid runtime block rejected (${accepted.error})`);
} else {
  console.log("  ok   valid runtime block accepted");
  const decoded = accepted.bots.a;
  expect("decoded context window", decoded.runtime?.contextWindow, 100_000);
  expect("decoded reserve tokens", decoded.runtime?.reserveTokens, 4_000);
  expect("decoded max retries", decoded.runtime?.maxRetries, 5);
  expect("decoded parallel tools", decoded.runtime?.parallelTools, false);
  expect("decoded commitments", decoded.commitments, true);
}

const absent = parseBotRegistry({ a: { model: "glm-5.3", systemPrompt: "x" } });
if (!absent.ok) {
  failures.push(`bot without runtime rejected: ${absent.error}`);
  console.log(`  FAIL bot without runtime rejected (${absent.error})`);
} else {
  console.log("  ok   bot without runtime accepted");
  expect("absent runtime", absent.bots.a.runtime, undefined);
  expect("absent commitments", absent.bots.a.commitments, undefined);
}

const rejects = (label, raw, needle) => {
  const result = parseBotRegistry(raw);
  if (result.ok) {
    failures.push(`${label}: expected an error, got ok`);
    console.log(`  FAIL ${label} (expected an error, got ok)`);
    return;
  }
  const names = result.error.includes(needle);
  if (!names) failures.push(`${label}: error "${result.error}" does not include "${needle}"`);
  console.log(`  ${names ? "ok  " : "FAIL"} ${label} (${result.error})`);
};

rejects(
  "runtime is not an object",
  { a: { model: "glm-5.3", systemPrompt: "x", runtime: 5 } },
  'at ["runtime"]',
);
rejects(
  "runtime.maxRetries is not a number",
  { a: { model: "glm-5.3", systemPrompt: "x", runtime: { maxRetries: "three" } } },
  'at ["runtime"]["maxRetries"]',
);
rejects(
  "runtime.contextWindow is not a number",
  { a: { model: "glm-5.3", systemPrompt: "x", runtime: { contextWindow: "big" } } },
  'at ["runtime"]["contextWindow"]',
);
rejects(
  "runtime.reserveTokens is not a number",
  { a: { model: "glm-5.3", systemPrompt: "x", runtime: { reserveTokens: null } } },
  'at ["runtime"]["reserveTokens"]',
);
rejects(
  "runtime.parallelTools is not a boolean",
  { a: { model: "glm-5.3", systemPrompt: "x", runtime: { parallelTools: "yes" } } },
  'at ["runtime"]["parallelTools"]',
);
rejects(
  "commitments is not a boolean",
  { a: { model: "glm-5.3", systemPrompt: "x", commitments: "yes" } },
  'at ["commitments"]',
);

// A field the shape does not know is dropped, not refused: the browser holds
// the edits and sends the whole configuration back.
{
  const result = parseBotRegistry({
    a: { model: "glm-5.3", systemPrompt: "x", runtime: { parallelTool: true } },
  });
  if (!result.ok) {
    failures.push(`unknown runtime field refused: ${result.error}`);
    console.log(`  FAIL unknown runtime field refused (${result.error})`);
  } else {
    console.log("  ok   unknown runtime field ignored");
    expect("unknown runtime field is dropped", result.bots.a.runtime?.parallelTool, undefined);
  }
}

// The bundled seed carries the policy Hermes runs under.
try {
  const raw = JSON.parse(readFileSync(new URL("../bots.json", import.meta.url), "utf8"));
  const seeded = parseBotRegistry(raw);
  if (!seeded.ok) {
    failures.push(`the bundled seed does not decode: ${seeded.error}`);
    console.log(`  FAIL the bundled seed does not decode (${seeded.error})`);
  } else {
    const bots = seeded.bots;
    expect("hermes max retries", bots.hermes.runtime?.maxRetries, 3);
    expect("hermes parallel tools", bots.hermes.runtime?.parallelTools, true);
    expect("hermes commitments", bots.hermes.commitments, true);
    expect("hermes has no context window", bots.hermes.runtime?.contextWindow, undefined);
    expect("scribe has no runtime", bots.scribe.runtime, undefined);
  }
} catch (error) {
  failures.push(`the bundled seed could not be read: ${error?.message ?? error}`);
  console.log(`  FAIL the bundled seed could not be read (${error?.message ?? error})`);
}

if (failures.length > 0) {
  console.error("runtime-policy smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("runtime-policy smoke passed");
process.exit(0);
