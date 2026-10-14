/**
 * BotRegistryService — Effect service wrapping the bot registry loader.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { getBot, loadBots } from "../bots.ts";
import type { BotConfig } from "../bots.ts";

export interface BotRegistry {
  readonly loadBots: () => Effect.Effect<Record<string, BotConfig>>;
  readonly getBot: (name: string) => Effect.Effect<BotConfig>;
  readonly bots: () => Effect.Effect<Record<string, BotConfig>>;
  readonly get: (name: string) => Effect.Effect<BotConfig>;
}

export class BotRegistryService extends Context.Service<BotRegistryService, BotRegistry>()(
  "mackbot/services/BotRegistryService",
) {
  static readonly layer = Layer.succeed(
    BotRegistryService,
    BotRegistryService.of({
      loadBots: () => Effect.sync(loadBots),
      getBot: (name) => Effect.sync(() => getBot(name)),
      bots: () => Effect.sync(loadBots),
      get: (name) => Effect.sync(() => getBot(name)),
    }),
  );
}

export type BotRegistryServiceContract = BotRegistry;
