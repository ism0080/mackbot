/**
 * Web bundle harness — hash the built browser bundle.
 *
 * The deploy ships `web/dist` as the Worker's static assets, so the built
 * bundle is part of the deployable artifact. Hash it here so a restructure can
 * prove the browser bundle did not change.
 *
 * Usage: bun tools/web-bundle-harness.mjs
 * Prints: <sha256 of every dist file, sorted by path>
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(import.meta.url)) + "/..";
const dist = join(repoRoot, "web", "dist");

/** Every file under a directory, as paths relative to it, sorted. */
const walk = (dir) => {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
};

const files = walk(dist);
if (files.length === 0) {
  console.error("harness: web/dist is empty — run `bun run --filter @mackbot/web build` first");
  process.exit(1);
}

const hash = createHash("sha256");
for (const file of files) {
  hash.update(relative(dist, file));
  hash.update("\0");
  hash.update(readFileSync(file));
  hash.update("\0");
}

console.log(`${hash.digest("hex")} ${files.length} files`);
for (const file of files) {
  console.log(`  ${relative(dist, file)} ${statSync(file).size}b`);
}
