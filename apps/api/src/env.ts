/**
 * env - the Worker's bindings, and the answer `Bot.wait` gives.
 *
 * Kept apart from the entry module so the router and the handlers can name
 * them without importing the Durable Object classes.
 */

import type { Bot } from "./bot.ts";
import type { Registry } from "./registry.ts";

export interface Env {
  readonly Bot: DurableObjectNamespace<Bot>;
  readonly Registry: DurableObjectNamespace<Registry>;
  readonly AI: Ai;
  readonly ASSETS: Fetcher;
  readonly EXECUTOR_URL: string;
  readonly EXECUTOR_TOKEN: string;
  readonly OPENCODE_API_KEY: string;
  readonly CHAT_BEARER_TOKEN: string;
}

export interface WaitResult {
  readonly operationId: string;
  readonly session: string;
  readonly status: "done" | "unanswered" | "timeout";
  readonly text?: string;
  readonly reason?: string;
}
