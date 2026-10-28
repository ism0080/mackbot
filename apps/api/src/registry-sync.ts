/**
 * registry-sync - keep a bot's installed extensions in step with its roster entry.
 *
 * The registry a bot runs on is created when pi's harness opens, but the roster
 * can change while the Durable Object stays alive. pi lets a registry change
 * while the harness runs: each task phase resolves hooks and the agent once,
 * from the registry at the phase's start, so the next phase, request, or call
 * uses the new code. Installing an extension under an installed name replaces
 * it in place, and installing one that is already installed is therefore safe
 * to repeat.
 *
 * Only per-bot extensions belong here. The Executor bridge, delegation, the
 * approval policy and the approval store are host wiring: they do not depend on
 * the bot's configuration and are installed once, when the harness opens.
 */

import type { BotConfig } from "./bots.ts";
import type { Extension, Registry } from "@earendil-works/pi-durable";

/** What a bot's configuration can switch on or off. */
export interface SyncDeps {
  readonly commitments: Extension;
}

/**
 * Install or remove the extensions `bot` declares.
 *
 * A synchronous registry operation: the registry publishes at once, and pi
 * applies the change at the next task phase or request.
 */
export const syncExtensions = (registry: Registry, bot: BotConfig, deps: SyncDeps): void => {
  if (bot.commitments === true) {
    registry.install(deps.commitments);
  } else {
    registry.uninstall(deps.commitments);
  }
};
