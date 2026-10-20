/**
 * runtime-policy — the run policy one bot runs under.
 *
 * pi-durable reads `HarnessSettings` at every use and never stores it, so the
 * policy is derived from the bot's own declaration instead of one settings
 * object shared by the whole fleet. A bot that knows its context window gets
 * compaction thresholds scaled to that window; a bot that does not falls back
 * to pi's own defaults.
 */

import type { HarnessSettings } from "@earendil-works/pi-durable";
import { Predicate } from "effect";

import type { BotConfig } from "./bots.ts";

/** A progress commit is a storage write, so it runs ten times less often than pi's default. */
const PROGRESS_INTERVAL_MS = 1_000;
/** An idle bot holds no cached context or documents; a Durable Object is billed by duration. */
const RETENTION_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
/** pi's own compaction defaults, for a bot whose context window is unknown. */
const DEFAULT_RESERVE_TOKENS = 16_384;
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const DEFAULT_BACKGROUND_TOKENS = 32_768;
/** A task cut off this many times in a row without progress is parked instead of run again. */
const DEFAULT_RESTART_LIMIT = 5;

/** The run policy one bot runs under. */
export const settingsFor = (bot: BotConfig): HarnessSettings => {
  const runtime = bot.runtime;
  const contextWindow = runtime?.contextWindow;
  const knownWindow = Predicate.isNumber(contextWindow) && contextWindow > 0;
  return {
    progress: {
      partialIntervalMs: PROGRESS_INTERVAL_MS,
      outputIntervalMs: PROGRESS_INTERVAL_MS,
    },
    compaction: {
      enabled: true,
      reserveTokens:
        runtime?.reserveTokens ??
        (knownWindow ? Math.round(contextWindow * 0.12) : DEFAULT_RESERVE_TOKENS),
      keepRecentTokens: knownWindow ? Math.round(contextWindow * 0.15) : DEFAULT_KEEP_RECENT_TOKENS,
      backgroundTokens: knownWindow ? Math.round(contextWindow * 0.25) : DEFAULT_BACKGROUND_TOKENS,
    },
    retry: { maxRetries: runtime?.maxRetries ?? DEFAULT_MAX_RETRIES },
    toolExecution: runtime?.parallelTools === false ? "sequential" : "parallel",
    contextRetentionMs: RETENTION_MS,
    documentRetentionMs: RETENTION_MS,
    restartLimit: runtime?.restartLimit ?? DEFAULT_RESTART_LIMIT,
    // A message the user sent while the bot was busy deserves a run of its own.
    // The harness's default keeps those messages queued until the user sends
    // another one, which for a chat bot means a message nobody ever sees
    // answered.
    afterFailedRun: "continue",
  };
};
