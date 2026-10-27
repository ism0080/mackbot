/**
 * Worker bundle harness — reproduce the deploy bundle offline.
 *
 * `bun alchemy deploy` bundles the Worker with rolldown plus the Cloudflare
 * plugin set, then minifies it. The CLI needs Cloudflare credentials before it
 * reaches that step, so this script drives the same bundler directly and writes
 * a hash of the output. Run it before and after a restructure; the hashes must
 * match, which proves the deployable artifact did not change.
 *
 * The configuration mirrors
 * `node_modules/alchemy/src/Cloudflare/Workers/Sources/Rolldown.ts`:
 * the Cloudflare plugin set, `format: "esm"`, `minify: true`, `keepNames: true`,
 * `strictExecutionOrder: true`, and the `cwd` that `findCwdForBundle` picks
 * (the nearest package.json above the entry).
 *
 * Usage: bun tools/worker-bundle-harness.mjs [entry]
 * Prints: <sha256> <byteLength> <path>
 */
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(import.meta.url)) + "/..";

// Alchemy resolves `rolldown` and the Cloudflare plugin set from its own
// node_modules, so the harness resolves them the same way. Resolving them from
// the repo root instead would pick a different copy, and the bundle would not
// be the one the deploy produces. The real path matters: `node_modules/alchemy`
// is a symlink into bun's isolated store, and only the real path walks up into
// the store's own node_modules.
const alchemyRequire = createRequire(
  realpathSync(join(repoRoot, "node_modules", "alchemy", "package.json")),
);
const { rolldown } = await import(alchemyRequire.resolve("rolldown"));

// Load the published `dist` build, the `import` condition the deploy runner
// uses. The pinned package's `bun` condition points at `src/rolldown/plugin.ts`,
// which imports a `./utils.ts` that the tarball does not ship.
const runtimeDir = dirname(alchemyRequire.resolve("@alchemy.run/cloudflare-runtime/package.json"));
const { default: cloudflare } = await import(join(runtimeDir, "dist/rolldown/plugin.js"));

/** The nearest package.json above a path, which is the bundler's cwd. */
const findCwdForBundle = (entry) => {
  let current = dirname(entry);
  for (;;) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return repoRoot;
    current = parent;
  }
};

const entry = resolve(repoRoot, process.argv[2] ?? "apps/api/src/index.ts");
const cwd = findCwdForBundle(entry);

const bundle = await rolldown({
  input: entry,
  cwd,
  external: ["lightningcss", "fsevents"],
  plugins: [cloudflare({ compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"] })],
  checks: { unresolvedImport: false, ineffectiveDynamicImport: false },
});

const { output } = await bundle.generate({
  format: "esm",
  sourcemap: false,
  minify: true,
  keepNames: true,
  strictExecutionOrder: true,
});

await bundle.close();

// Hash every emitted chunk in a stable order, so a chunk split or rename
// changes the hash. Sorted by file name to stay order-independent.
const chunks = output
  .filter((item) => item.type === "chunk")
  .map((item) => ({ name: item.fileName, code: item.code }))
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

if (chunks.length === 0) {
  console.error("harness: no chunks emitted");
  process.exit(1);
}

const hash = createHash("sha256");
let bytes = 0;
for (const chunk of chunks) {
  hash.update(chunk.name);
  hash.update("\0");
  hash.update(chunk.code);
  hash.update("\0");
  bytes += chunk.code.length;
}

console.log(`${hash.digest("hex")} ${bytes} ${chunks.length}`);
for (const chunk of chunks) console.log(`  chunk ${chunk.name} ${chunk.code.length}b`);
