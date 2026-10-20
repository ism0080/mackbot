/**
 * vendor-pi — build the Pi packages mackbot pins, from a git SHA.
 *
 * mackbot needs Pi's unreleased features (the failure taxonomy, durable
 * sleeps, the wake alarm, tracing), and they are not on npm yet. So the
 * packages are built from a pinned commit of the Pi monorepo and vendored here
 * as tarballs, which `package.json` installs with `overrides` so that Pi's own
 * dependencies resolve to the same build instead of the published ones.
 *
 * The SHA is the pin. Nothing here tracks a branch, so a rebuild produces the
 * same bytes. Re-run this only when the pin moves:
 *
 *     bun tools/vendor-pi.mjs
 *
 * It needs a network and a few minutes, because it installs each package's
 * dependencies before building it.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The Pi commit mackbot vendors. Move this, and only this, to move the pin. */
export const PI_SHA = "0ed1b0431444f1e9321c5cf3a9e0acd04da11f89";

const REPOSITORY = "https://github.com/earendil-works/pi.git";

/**
 * The packages, in the order they must be built: each one's types come from
 * the ones before it, so a build that skipped one would compile against a
 * sibling that is not there.
 */
const PACKAGES = ["telemetry", "chord", "ai", "codemode", "durable"];

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const vendorDir = join(repoRoot, "vendor", "pi");

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
  }
};

const checkout = (sha) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-vendor-"));
  run("git", ["clone", "--quiet", REPOSITORY, directory]);
  run("git", ["checkout", "--quiet", sha], directory);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" });
  if (head.stdout.trim() !== sha) {
    throw new Error(`the clone is at ${head.stdout.trim()}, not the pinned ${sha}`);
  }
  // The monorepo's root sets up git hooks in a `prepare` script, which fails the
  // install of any package inside it when husky is not installed yet. A vendored
  // build wants no hooks.
  run("npm", ["pkg", "delete", "scripts.prepare"], directory);
  return directory;
};

const build = (directory) => {
  for (const name of PACKAGES) {
    const packageDir = join(directory, "packages", name);
    console.log(`building ${name}`);
    run("npm", ["install", "--no-audit", "--no-fund"], packageDir);
    run("npm", ["run", "build"], packageDir);
  }
};

const pack = (directory) => {
  mkdirSync(vendorDir, { recursive: true });
  for (const name of PACKAGES) {
    const packageDir = join(directory, "packages", name);
    run("npm", ["pack", "--pack-destination", vendorDir], packageDir);
  }
  return readdirSync(vendorDir).filter((name) => name.endsWith(".tgz"));
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const directory = checkout(PI_SHA);
  try {
    build(directory);
    const written = pack(directory);
    console.log(`\nwrote ${written.length} tarballs to ${vendorDir}`);
    for (const name of written) console.log(`  ${name}`);
    console.log("\nrun `bun install` to pick them up");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
