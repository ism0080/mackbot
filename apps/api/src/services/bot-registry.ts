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
import * as Schema from "effect/Schema";

import type { BotConfig } from "../bots.ts";
import { describeCause } from "../errors.ts";
import type { RegistryWrite } from "../registry-store.ts";
import type { Env } from "../index.ts";

/**
 * The registry's one instance. The roster is one fleet-wide fact, so it has
 * one owner and one name.
 */
export const REGISTRY_NAME = "registry";

/**
 * The registry did not answer: the RPC rejected, or the Durable Object threw.
 * A typed failure rather than a defect, so a route can answer it with a status
 * of its own instead of the catch-all's.
 */
export class RegistryUnavailable extends Schema.TaggedError<RegistryUnavailable>()(
  "RegistryUnavailable",
  {
    /** The registry call that failed. */
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export interface BotRegistry {
  /** Every bot the fleet runs, keyed by bot id. */
  readonly roster: () => Effect.Effect<Record<string, BotConfig>, RegistryUnavailable>;
  /** One bot, or nothing when the registry does not declare it. */
  readonly bot: (name: string) => Effect.Effect<BotConfig | undefined, RegistryUnavailable>;
  /**
   * Several bots in one round trip, keyed by id; an undeclared id is absent.
   * A caller that needs more than one bot asks once instead of once per bot.
   */
  readonly bots: (
    names: readonly string[],
  ) => Effect.Effect<Record<string, BotConfig>, RegistryUnavailable>;
  /** The one write: a create or a replace, and what it decided. */
  readonly write: (
    name: string,
    bot: BotConfig,
    mode: "create" | "replace",
  ) => Effect.Effect<RegistryWrite, RegistryUnavailable>;
}

/** One RPC to the registry, its rejection a typed failure naming the call. */
const callRegistry = <A>(
  operation: string,
  call: () => Promise<A>,
): Effect.Effect<A, RegistryUnavailable> =>
  Effect.tryPromise({
    try: call,
    catch: (cause) => new RegistryUnavailable({ operation, message: describeCause(cause) }),
  });

export class BotRegistryService extends Context.Service<BotRegistryService, BotRegistry>()(
  "mackbot/services/BotRegistryService",
) {
  static readonly layerFor = (env: Env): Layer.Layer<BotRegistryService> =>
    Layer.succeed(
      BotRegistryService,
      BotRegistryService.of({
        roster: () => callRegistry("roster", () => env.Registry.getByName(REGISTRY_NAME).roster()),
        bot: (name) => callRegistry("bot", () => env.Registry.getByName(REGISTRY_NAME).bot(name)),
        bots: (names) =>
          callRegistry("bots", () => env.Registry.getByName(REGISTRY_NAME).bots(names)),
        write: (name, bot, mode) =>
          // The answer is a union, and the stub types a union as the
          // intersection of its branches, so the promise says what the
          // registry answers.
          callRegistry(
            "put",
            async (): Promise<RegistryWrite> =>
              await env.Registry.getByName(REGISTRY_NAME).put(name, bot, mode),
          ),
      }),
    );
}
