/**
 * The Worker entry: the fetch and cron handlers, and the Durable Object
 * classes. Cloudflare looks for a Durable Object class in the entry module,
 * and the class name has to match the binding name, so `Bot` and `Registry`
 * are re-exported here; the code lives in `bot.ts`, `registry.ts`, `router.ts`
 * and `routes.ts`.
 */

import type { Env } from "./env.ts";
import { handleFetch, handleScheduled } from "./router.ts";

export { Bot } from "./bot.ts";
export { Registry } from "./registry.ts";
export type { Env, WaitResult } from "./env.ts";

export default {
  fetch: handleFetch,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env>;
