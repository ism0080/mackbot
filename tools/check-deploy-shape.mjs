/**
 * deploy-shape — assert the invariants the deploy path rests on.
 *
 * `apps/api` is the deployable app. `Cloudflare.Website.Foldkit` owns the browser
 * build: its `rootDir` is a Vite root resolved against the process's working
 * directory, which is the app package because the deploy runs there (`bun run
 * deploy` filters to `@mackbot/api`), and its `main` is resolved against that
 * Vite root (`resolveViteMain` in `@alchemy.run/cloudflare/src/Workers/
 * ViteMain.ts`). So `main` has to be spelled from `apps/web`, not from
 * `apps/api`.
 *
 * The entry's nearest `package.json` must still be the app manifest, since that
 * manifest declares every Worker dependency Vite resolves from the entry.
 *
 * This asserts that shape, so a package added under `apps/api/src/` cannot move
 * that root, and a moved app cannot silently point the build at nothing.
 *
 * Run with: bun tools/check-deploy-shape.mjs
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The deployable app, relative to the repo root. */
const APP = "apps/api";

/** The Worker's entry module, relative to the app. */
const ENTRY = "src/index.ts";

/** The browser app, relative to the repo root: the Website's Vite root. */
const WEB = "apps/web";

const appDir = join(repoRoot, APP);
const webDir = join(repoRoot, WEB);
const entry = join(appDir, ENTRY);

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
};

/** The nearest `package.json` above the entry. Mirrors `findCwdForBundle`. */
const findCwdForBundle = (start) => {
  let current = dirname(start);
  for (;;) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return repoRoot;
    current = parent;
  }
};

/** The first string literal named by `key: "…"` in `alchemy.run.ts`. */
const readProp = (source, key) => {
  const match = source.match(new RegExp(`\\b${key}:\\s*"([^"]+)"`, "u"));
  return match?.[1];
};

const alchemy = await Bun.file(join(appDir, "alchemy.run.ts")).text();
const rootDir = readProp(alchemy, "rootDir");
const main = readProp(alchemy, "main");

console.log("deploy shape");

check("the API app exists", existsSync(join(appDir, "package.json")), APP);
check("the Worker entry exists", existsSync(entry), `${APP}/${ENTRY}`);
check("the browser app exists", existsSync(join(webDir, "package.json")), WEB);
check("the browser app has a Vite config", existsSync(join(webDir, "vite.config.ts")), WEB);

// The bundler must resolve from the app manifest, because that manifest
// declares every Worker dependency and the contract workspace link.
check(
  "the Worker's dependencies resolve from apps/api",
  findCwdForBundle(entry) === appDir,
  findCwdForBundle(entry),
);

// A manifest under the app's source or tests would capture that resolution and
// change the Worker's dependencies.
for (const manifest of ["src/package.json", "tests/package.json"]) {
  check(`no ${manifest} captures the entry`, !existsSync(join(appDir, manifest)));
}

// `alchemy.run.ts` has to name the Vite root the build runs in.
check("alchemy.run.ts declares a rootDir", rootDir !== undefined, String(rootDir));

const viteRoot = rootDir === undefined ? undefined : resolve(appDir, rootDir);
check("rootDir is the browser app", viteRoot === webDir, String(viteRoot));

// ...and `main` has to resolve from that root to the real entry. This is the
// mistake the old `./src/index.ts` spelling invited: `..` from the Vite root is
// `apps/`, not `apps/api/`.
const resolvedMain = main === undefined ? undefined : resolve(viteRoot, main);
check(
  "main resolves to the Worker entry",
  resolvedMain === entry,
  `${String(main)} → ${String(resolvedMain)}`,
);

if (failures.length > 0) {
  console.error(`\n${failures.length} deploy-shape checks failed`);
  process.exit(1);
}
console.log("\ndeploy shape is as expected");
