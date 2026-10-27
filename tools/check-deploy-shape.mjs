/**
 * deploy-shape — assert the invariants the deploy path rests on.
 *
 * `apps/api` is the deployable app. Alchemy resolves `main` and
 * `assets.directory` against the process's working directory, which is the app
 * package because the deploy runs there (`bun run deploy` filters to
 * `@mackbot/api`). The bundler's working directory is the nearest `package.json`
 * above the entry module (`findCwdForBundle` in
 * `node_modules/alchemy/src/Bundle/TempRoot.ts`), which must be that same
 * `apps/api` manifest, since it declares the Worker's dependencies.
 *
 * This asserts that shape, so a package added under `apps/api/src/` cannot move
 * the bundler's root without anyone noticing.
 *
 * Run with: bun tools/check-deploy-shape.mjs
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The deployable app, relative to the repo root. */
const APP = "apps/api";

/** The Worker's entry module, as `alchemy.run.ts` names it. */
const ENTRY = "src/index.ts";

/** The static assets directory, as `alchemy.run.ts` names it. */
const ASSETS = "../web/dist";

const appDir = join(repoRoot, APP);

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

const entry = join(appDir, ENTRY);

console.log("deploy shape");

check("the API app exists", existsSync(join(appDir, "package.json")), APP);
check("the Worker entry exists", existsSync(entry), `${APP}/${ENTRY}`);

// The bundler must resolve from the app manifest, because that manifest
// declares every Worker dependency and the contract workspace link. The Pi
// tarball overrides stay on the root manifest, which Bun applies workspace-wide.
check(
  "the bundler resolves from apps/api",
  findCwdForBundle(entry) === appDir,
  findCwdForBundle(entry),
);

// A manifest under the app's source or tests would capture the bundler's
// working directory and change the Worker's dependency resolution.
for (const manifest of ["src/package.json", "tests/package.json"]) {
  check(`no ${manifest} captures the bundler`, !existsSync(join(appDir, manifest)));
}

// The assets directory is resolved against the app's working directory too.
check("the assets directory exists", existsSync(join(appDir, ASSETS)), ASSETS);

// The deploy entry names the paths this script asserts.
const alchemy = await Bun.file(join(appDir, "alchemy.run.ts")).text();
check("alchemy.run.ts points at the Worker entry", alchemy.includes(`"./${ENTRY}"`));
check("alchemy.run.ts points at the assets directory", alchemy.includes(`"${ASSETS}"`));

if (failures.length > 0) {
  console.error(`\n${failures.length} deploy-shape checks failed`);
  process.exit(1);
}
console.log("\ndeploy shape is as expected");
