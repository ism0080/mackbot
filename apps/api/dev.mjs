/**
 * Launcher for `alchemy dev`.
 *
 * `alchemy`'s `bin/cli.js` hands itself off to Bun whenever `npm_execpath` names
 * bun — "started by bun as a package manager: run the CLI under bun, as asked".
 * Under Bun the CLI resolves its own sources, and the Website resource then
 * spawns its Vite dev child with `bin/register-dev-mode.js`, a file the
 * published `alchemy` package does not ship (2.0.0-beta.84). Spawning Node with
 * `npm_execpath` cleared keeps the CLI on its compiled `lib/` and its published
 * `bin/register-oxc.js` loader, which is the combination that works.
 *
 * Delete this file and point the `dev` script back at `alchemy dev` once a
 * release ships that file.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// `npm_execpath` is how the CLI decides who launched it; the rest of the
// environment (profiles, CI, PATH) is passed through untouched.
const { npm_execpath: _launcher, ...env } = process.env;

const child = spawn(
  "node",
  [join(here, "node_modules", "alchemy", "bin", "cli.js"), "dev", "--env-file", "../../.env"],
  { cwd: here, stdio: "inherit", env },
);

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
