import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const fixture = "tests/fixtures/no-direct-fetch.ts";
const config = "tests/fixtures/oxlint.json";
const executable = fileURLToPath(
  new URL("../../../node_modules/oxlint/bin/oxlint", import.meta.url),
);
const result = spawnSync(process.execPath, [executable, "--config", config, fixture], {
  cwd: packageDirectory,
  encoding: "utf8",
});
const output = `${result.stdout}${result.stderr}`;

if (result.status !== 1 || !output.includes("forge(no-direct-fetch)")) {
  throw new Error(`Built plugin smoke test failed.\n${output}`);
}
