/**
 * mackbot infrastructure — Alchemy v2 (Infrastructure-as-Effects).
 *
 * One async Worker hosts the front door and the exported `Bot` and `Registry`
 * Durable Object classes. `Cloudflare.DurableObject<Bot>("Bot")` binds the
 * class: Alchemy declares it in Cloudflare's declarative `exports` map and
 * gives every new hosted class SQLite storage, so each `Bot` instance is
 * SQLite-backed — what pi-durable's storage needs. The `Registry` binding is
 * the same: one instance holds the roster, in one SQLite table. A class that
 * stops being exported fails the deploy instead of losing its namespace, so
 * both stay exported from `src/index.ts`.
 * `Cloudflare.Workers.AI()` binds Workers AI for the cheap `@cf/…` model tier.
 * `Cloudflare.RateLimit` binds the per-client `/login` allowance; its numbers
 * live in `src/login-limit.ts`, which the Worker reads too.
 *
 * Secrets (`EXECUTOR_URL`, `EXECUTOR_TOKEN`, `OPENCODE_API_KEY`,
 * `CHAT_BEARER_TOKEN`) resolve from the environment via `Config.Redacted` and
 * bind as `secret_text`. `nodejs_compat` is required: pi-ai reads
 * `OPENCODE_API_KEY` from `process.env`, and the agents lifecycle and the MCP
 * SDK use Node built-ins.
 *
 * `Cloudflare.Website.Foldkit` builds the sibling `apps/web` app and deploys it
 * as this Worker's assets, so a deploy cannot ship a stale `dist/`: the Vite
 * build runs from the stack, content-hashed and memoized (`memo` names the API
 * and the shared contract as inputs too, or a Worker-only edit would reuse the
 * last bundle). `rootDir` is the browser app, so `main` resolves from that root
 * and reads `../api/src/index.ts`. `runWorkerFirst` routes every request
 * through this Worker before the asset layer, because `/status` and its
 * siblings would otherwise be answered by the SPA fallback. The Worker handles
 * its own routes and hands everything else to `env.ASSETS`. `alchemy dev` runs
 * the same pair: the Worker in workerd with its bindings, and the Foldkit app on
 * Vite's dev server behind it, which is what keeps the browser same-origin in
 * development — its cookie and CSRF checks need it.
 *
 * This is a fresh project: nothing is adopted (`adopt(true)` is not used).
 */

import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

import type { Bot } from "./src/index.ts";
import {
  LOGIN_ATTEMPT_LIMIT,
  LOGIN_ATTEMPT_PERIOD_SECONDS,
  LOGIN_RATE_LIMIT_NAMESPACE,
} from "./src/login-limit.ts";
import type { Registry } from "./src/registry.ts";

export default Alchemy.Stack(
  "mackbot",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Website.Foldkit("Mackbot", {
      // The Vite root: the sibling browser app. `main` resolves from here.
      rootDir: "../web",
      main: "../api/src/index.ts",
      // A stale Worker bundle is the same bug as stale assets, so the build
      // hashes the API and the shared contract too, not just the browser app.
      memo: {
        include: [
          "index.html",
          "package.json",
          "public/**",
          "src/**",
          "vite.config.ts",
          "../api/src/**",
          "../api/bots.json",
          "../../packages/contract/src/**",
        ],
        lockfile: true,
      },
      compatibility: {
        // Current date with nodejs_compat spelled out: Alchemy only adds it by
        // default for dates before 2026-08-04.
        date: "2026-10-01",
        flags: ["nodejs_compat"],
      },
      crons: ["0 * * * *"],
      assets: {
        // The SPA fallback is already this resource's default for a
        // client-only app; `runWorkerFirst` is the part that is ours.
        runWorkerFirst: true,
      },
      env: {
        Bot: Cloudflare.DurableObject<Bot>("Bot"),
        Registry: Cloudflare.DurableObject<Registry>("Registry"),
        AI: Cloudflare.Workers.AI(),
        LOGIN_RATE_LIMIT: Cloudflare.RateLimit("LOGIN_RATE_LIMIT", {
          namespaceId: LOGIN_RATE_LIMIT_NAMESPACE,
          simple: { limit: LOGIN_ATTEMPT_LIMIT, period: LOGIN_ATTEMPT_PERIOD_SECONDS },
        }),
        EXECUTOR_URL: Config.Redacted("EXECUTOR_URL"),
        EXECUTOR_TOKEN: Config.Redacted("EXECUTOR_TOKEN"),
        OPENCODE_API_KEY: Config.Redacted("OPENCODE_API_KEY"),
        CHAT_BEARER_TOKEN: Config.Redacted("CHAT_BEARER_TOKEN"),
      },
    });

    return { url: worker.url };
  }),
);
