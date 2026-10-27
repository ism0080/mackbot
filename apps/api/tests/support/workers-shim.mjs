/**
 * Re-exec a test under the `cloudflare:workers` shim.
 *
 * `src/index.ts`, `src/registry.ts` and `agents/lifecycle` import the
 * `cloudflare:workers` builtin, which Bun cannot resolve outside workerd. Call
 * `withWorkersShim(import.meta.url)` before the first Worker import: the first
 * run spawns the same file with `support/workers-shim-preload.mjs` preloaded,
 * and the child (which sees `MACKBOT_WORKERS_SHIM=1`) continues in place.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const preload = join(here, "workers-shim-preload.mjs");

export const withWorkersShim = (testUrl) => {
  if (process.env.MACKBOT_WORKERS_SHIM === "1") return;

  const result = spawnSync(process.execPath, ["--preload", preload, fileURLToPath(testUrl)], {
    stdio: "inherit",
    env: { ...process.env, MACKBOT_WORKERS_SHIM: "1" },
  });
  process.exit(result.status ?? 1);
};
