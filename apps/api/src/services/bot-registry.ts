/**
 * bot-registry — the Effect service that reads and writes the roster.
 *
 * The roster lives in the `Registry` Durable Object, so this service is the one
 * place that knows how to reach it. The layer takes the environment, because
 * the environment is what carries the binding the Durable Object's namespace
 * comes from; the service itself stays a plain Effect interface, so the rest
 * of the Worker reads the roster without knowing where it lives.
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { BotConfig } from "../bots.ts";
import type { RegistryWrite } from "../registry-store.ts";
import type { Env } from "../index.ts";

/**
 * The registry's one instance. The roster is one fleet-wide fact, so it has
 * one owner and one name.
 */
export const REGISTRY_NAME = "registry";

export interface BotRegistry {
  /** Every bot the fleet runs, keyed by bot id. */
  readonly roster: () => Effect.Effect<Record<string, BotConfig>>;
  /** One bot, or nothing when the registry does not declare it. */
  readonly bot: (name: string) => Effect.Effect<BotConfig | undefined>;
  /** The one write: a create or a replace, and what it decided. */
  readonly write: (
    name: string,
    bot: BotConfig,
    mode: "create" | "replace",
  ) => Effect.Effect<RegistryWrite>;
}

export class BotRegistryService extends Context.Service<BotRegistryService, BotRegistry>()(
  "mackbot/services/BotRegistryService",
) {
  static readonly layerFor = (env: Env): Layer.Layer<BotRegistryService> =>
    Layer.succeed(
      BotRegistryService,
      BotRegistryService.of({
        // The registry either answers or the Worker is broken: a rejected RPC is
        // a defect, not a typed failure every caller would have to handle.
        roster: () => Effect.promise(() => env.Registry.getByName(REGISTRY_NAME).roster()),
        bot: (name) => Effect.promise(() => env.Registry.getByName(REGISTRY_NAME).bot(name)),
        write: (name, bot, mode) =>
          // The answer is a union, and the stub types a union as the
          // intersection of its branches, so the promise says what the
          // registry answers.
          Effect.promise(
            async (): Promise<RegistryWrite> =>
              await env.Registry.getByName(REGISTRY_NAME).put(name, bot, mode),
          ),
      }),
    );
}
