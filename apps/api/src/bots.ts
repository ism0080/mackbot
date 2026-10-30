/**
 * bots — the bot registry's rules.
 *
 * The shape of a bot lives in the contract package, because the browser reads
 * it as well as the Worker: a bot's model, prompt, thinking level, brief,
 * delegate list and run policy are one vocabulary that the Worker applies and
 * the browser edits.
 *
 * What lives here is what the shape cannot say. A model has to be one the
 * provider knows, a thinking level has to be one that model supports, and a
 * delegate list has to name bots that exist. Those are the rules, and they are
 * the same rules whether a bot arrives in the seed file or through a write
 * from the browser.
 */

import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { BotConfigSchema } from "@mackbot/contract";
import type { BotConfig, ModelRef } from "@mackbot/contract";
import { MODEL_VARIANTS } from "@mackbot/contract/catalog";
import type { ThinkingLevel } from "@mackbot/contract/catalog";

export type { BotConfig, ModelRef };

const WORKERS_AI_PREFIX = "@cf/";

const VARIANT_INDEX = new Map<string, readonly ThinkingLevel[]>(Object.entries(MODEL_VARIANTS));
const KNOWN_MODEL_IDS = Object.keys(MODEL_VARIANTS).join(", ");

const fail = (message: string): Effect.Effect<never, Error> => Effect.fail(new Error(message));

/**
 * The model a bot declares has to be one the provider can actually serve.
 *
 * A Workers AI model is named by its own `@cf/...` path, which the catalog
 * does not list, so the path's shape is the rule there. Every other model is
 * named by its catalog id, so an unknown id is a mistake worth naming.
 */
const checkModel = (botId: string, model: string): Effect.Effect<void, Error> => {
  if (model.startsWith(WORKERS_AI_PREFIX)) return Effect.void;
  return VARIANT_INDEX.has(model)
    ? Effect.void
    : fail(
        `bot "${botId}" model "${model}" is not in the OpenCode Go catalog. Known ids: ${KNOWN_MODEL_IDS}`,
      );
};

/**
 * A thinking level is only meaningful for a model that has thinking variants,
 * and only the ones that model lists.
 */
const checkThinkingLevel = (
  botId: string,
  model: string,
  level: ThinkingLevel,
): Effect.Effect<void, Error> => {
  if (model.startsWith(WORKERS_AI_PREFIX)) return Effect.void;
  const variants = VARIANT_INDEX.get(model);
  if (variants === undefined) {
    return fail(`bot "${botId}" model "${model}" is not in the OpenCode Go catalog`);
  }
  if (variants.length === 0) {
    return fail(`bot "${botId}" model "${model}" has no thinking variants; omit "thinkingLevel"`);
  }
  if (!variants.includes(level)) {
    return fail(
      `bot "${botId}" thinkingLevel "${level}" is not supported by "${model}" (allowed: ${variants.join(", ")})`,
    );
  }
  return Effect.void;
};

/**
 * The rules one bot's configuration has to satisfy.
 *
 * The shape has already been decoded by the time this runs, so what is left is
 * the part the shape cannot carry: a model the provider knows, and a thinking
 * level that model supports.
 */
export const checkBotConfig = (botId: string, bot: BotConfig): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    yield* checkModel(botId, bot.model);
    if (bot.thinkingLevel !== undefined) {
      yield* checkThinkingLevel(botId, bot.model, bot.thinkingLevel);
    }
  });

/**
 * The rules the roster has to satisfy as a whole.
 *
 * A bot's delegate list names bots that must exist, because a list naming a
 * bot that is not there is a delegation that can only fail. A bot may not
 * delegate to itself, and the roster may not be empty, because a fleet with no
 * bots has nothing to run.
 */
export const validateRoster = (
  bots: Readonly<Record<string, BotConfig>>,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    if (Object.keys(bots).length === 0) {
      return yield* fail("the registry is empty; declare at least one bot");
    }
    for (const [botId, bot] of Object.entries(bots)) {
      for (const target of bot.delegatesTo ?? []) {
        if (!Object.hasOwn(bots, target)) {
          return yield* fail(
            `bot "${botId}" delegatesTo "${target}", which is not a declared bot (declared: ${Object.keys(bots).join(", ")})`,
          );
        }
        if (target === botId) {
          return yield* fail(`bot "${botId}" delegatesTo itself`);
        }
      }
    }
  });

export type BotRegistryParse =
  | { readonly ok: true; readonly bots: Record<string, BotConfig> }
  | { readonly ok: false; readonly error: string };

/**
 * A JSON value, as the seed file holds it.
 *
 * A bot's own shape is the contract's, but the document around it is read
 * before it is known, so it arrives as JSON.
 */
export type RawJson =
  | string
  | number
  | boolean
  | null
  | readonly RawJson[]
  | { readonly [key: string]: RawJson };

/**
 * Decode a roster that arrived as raw JSON, the way the seed file does.
 *
 * The shape comes from the contract and the rules from this module, so a seed
 * file and a write from the browser are held to the same standard.
 */
export const parseBotRegistry = (raw: RawJson): BotRegistryParse =>
  Effect.runSync(
    Effect.gen(function* () {
      if (!Predicate.isObject(raw)) {
        return yield* fail("the registry must be a JSON object keyed by bot id");
      }
      const bots: Record<string, BotConfig> = {};
      for (const [botId, rawBot] of Object.entries(raw)) {
        if (botId.trim().length === 0) return yield* fail("bot ids must be non-empty strings");
        const bot = yield* Schema.decodeUnknownEffect(BotConfigSchema)(rawBot).pipe(
          Effect.mapError((cause) => new Error(`bot "${botId}": ${cause.message}`)),
        );
        yield* checkBotConfig(botId, bot);
        bots[botId] = bot;
      }
      yield* validateRoster(bots);
      return bots;
    }).pipe(
      Effect.match({
        onSuccess: (bots): BotRegistryParse => ({ ok: true, bots }),
        onFailure: (error): BotRegistryParse => ({ ok: false, error: error.message }),
      }),
    ),
  );

/**
 * The model a bot runs on, in the shape the status view carries.
 *
 * A Workers AI model is named by its `@cf/...` path; every other model comes
 * from the OpenCode Go catalog.
 */
export const resolveModelRef = (bot: BotConfig): ModelRef => ({
  provider: bot.model.startsWith(WORKERS_AI_PREFIX) ? "cloudflare" : "opencode-go",
  id: bot.model,
});
