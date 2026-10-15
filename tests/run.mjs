/**
 * Smoke-test runner.
 *
 * Runs every `*.smoke.mjs` in this directory in its own subprocess, so one
 * failing suite cannot hide the rest, and exits non-zero if any of them fail.
 *
 * Run with: bun tests/run.mjs
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tests = readdirSync(here)
  .filter((name) => name.endsWith(".smoke.mjs"))
  .sort();

let failed = 0;
for (const test of tests) {
  console.log(`\n==> ${test}`);
  const result = spawnSync(process.execPath, [join(here, test)], { stdio: "inherit" });
  if (result.status !== 0) {
    failed += 1;
    console.error(`FAILED: ${test}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${tests.length} test files failed`);
  process.exit(1);
}
console.log(`\nall ${tests.length} test files passed`);
