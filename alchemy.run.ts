/**
 * mackbot infrastructure — Alchemy v2 (Infrastructure-as-Effects).
 *
 * One async Worker hosts the front door and the exported `Bot` Durable Object
 * class. `Cloudflare.DurableObject<Bot>("Bot")` binds the class and drives
 * Cloudflare's `new_sqlite_classes` migration, so each `Bot` instance is
 * SQLite-backed — what pi-durable's storage needs. `Cloudflare.Workers.AI()`
 * binds Workers AI for the cheap `@cf/…` model tier.
 *
 * Secrets (`EXECUTOR_URL`, `EXECUTOR_TOKEN`, `OPENCODE_API_KEY`,
 * `CHAT_BEARER_TOKEN`) resolve from the environment via `Config.Redacted` and
 * bind as `secret_text`. `nodejs_compat` is required: pi-ai reads
 * `OPENCODE_API_KEY` from `process.env`, and the agents lifecycle and the MCP
 * SDK use Node built-ins.
 *
 * This is a fresh project: nothing is adopted (`adopt(true)` is not used).
 */

import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

import type { Bot } from "./src/index.ts";

export default Alchemy.Stack(
  "mackbot",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Worker("Mackbot", {
      main: "./src/index.ts",
      compatibility: {
        // Current date with nodejs_compat spelled out: Alchemy only adds it by
        // default for dates before 2026-08-04.
        date: "2026-10-01",
        flags: ["nodejs_compat"],
      },
      crons: ["0 * * * *"],
      env: {
        Bot: Cloudflare.DurableObject<Bot>("Bot"),
        AI: Cloudflare.Workers.AI(),
        EXECUTOR_URL: Config.Redacted("EXECUTOR_URL"),
        EXECUTOR_TOKEN: Config.Redacted("EXECUTOR_TOKEN"),
        OPENCODE_API_KEY: Config.Redacted("OPENCODE_API_KEY"),
        CHAT_BEARER_TOKEN: Config.Redacted("CHAT_BEARER_TOKEN"),
      },
    });

    return { url: worker.url };
  }),
);
