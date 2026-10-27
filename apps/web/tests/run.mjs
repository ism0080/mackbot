/*
 * Runs every `*.test.mjs` in this directory in its own subprocess. Each one
 * boots the bundle against its own stub, so the module cache and the DOM never
 * carry a previous scenario's state between runs.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tests = readdirSync(here)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort();

const results = tests.map((test) => {
  console.log(`\n==> ${test}`);
  const result = spawnSync(process.execPath, [join(here, test)], { stdio: "inherit" });
  if (result.status !== 0) console.error(`FAILED: ${test}`);
  return result.status === 0;
});
const failed = results.filter((passed) => !passed).length;

if (failed > 0) {
  console.error(`\n${failed} of ${tests.length} test files failed`);
  process.exit(1);
}
console.log(`\nall ${tests.length} test files passed`);
