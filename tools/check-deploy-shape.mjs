/**
 * deploy-shape — assert the invariants the deploy path rests on.
 *
 * Alchemy resolves `main` and `assets.directory` against the process's working
 * directory, and the bundler's working directory is the nearest `package.json`
 * above the entry module (`findCwdForBundle` in
 * `node_modules/alchemy/src/Bundle/TempRoot.ts`). So a `package.json` appearing
 * between the repo root and `src/index.ts` would silently change which
 * manifest the Worker bundle resolves its dependencies from.
 *
 * This asserts that shape, so a future package added under `src/` cannot move
 * the bundler's root without anyone noticing.
 *
 * Run with: bun tools/check-deploy-shape.mjs
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The Worker's entry module, as `alchemy.run.ts` names it. */
const ENTRY = "src/index.ts";

/** The static assets directory, as `alchemy.run.ts` names it. */
const ASSETS = "web/dist";

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
};

/**
 * The bundler's working directory: the nearest `package.json` above the entry.
 * Mirrors `findCwdForBundle`.
 */
const findCwdForBundle = (entry) => {
  let current = dirname(entry);
  for (;;) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return repoRoot;
    current = parent;
  }
};

const entry = join(repoRoot, ENTRY);

console.log("deploy shape");

check("the Worker entry exists", existsSync(entry), ENTRY);

// The bundler must resolve from the repo root, because that manifest declares
// every Worker dependency, the Pi overrides, and the contract workspace link.
check(
  "the bundler resolves from the repo root",
  findCwdForBundle(entry) === repoRoot,
  findCwdForBundle(entry),
);

// A manifest under `src/` would capture the bundler's working directory and
// change the Worker's dependency resolution.
for (const manifest of ["src/package.json", "tests/package.json"]) {
  check(`no ${manifest} captures the bundler`, !existsSync(join(repoRoot, manifest)));
}

// The assets directory is resolved against the working directory too.
check("the assets directory exists", existsSync(join(repoRoot, ASSETS)), ASSETS);

// The deploy entry names the paths this script asserts.
const alchemy = await Bun.file(join(repoRoot, "alchemy.run.ts")).text();
check("alchemy.run.ts points at the Worker entry", alchemy.includes(`"./${ENTRY}"`));
check("alchemy.run.ts points at the assets directory", alchemy.includes(`"./${ASSETS}"`));

if (failures.length > 0) {
  console.error(`\n${failures.length} deploy-shape checks failed`);
  process.exit(1);
}
console.log("\ndeploy shape is as expected");
