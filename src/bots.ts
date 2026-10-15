import botsJson from "../bots.json";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface RawObject {
  readonly [key: string]: RawJson;
}
export type RawJson = string | number | boolean | null | readonly RawJson[] | RawObject;

const OPENCODE_GO_PROVIDER_ID = "opencode-go";
const CLOUDFLARE_PROVIDER_ID = "cloudflare";
const WORKERS_AI_PREFIX = "@cf/";

export type ProviderId = typeof OPENCODE_GO_PROVIDER_ID | typeof CLOUDFLARE_PROVIDER_ID;

export interface ModelRef {
  readonly provider: ProviderId;
  readonly id: string;
}

export type ModelDecl =
  | string
  | { readonly provider: typeof OPENCODE_GO_PROVIDER_ID; readonly modelId: string };

export const MODEL_VARIANTS = {
  "deepseek-v4-pro": ["high", "max"],
  "deepseek-v4.1-flash": ["low", "high", "max"],
  "deepseek-v4-flash": ["low", "high", "max"],
  "glm-5.3": ["low", "high", "max"],
  "glm-5.3-flash": ["low", "high", "max"],
  "kimi-k2.7-code": [],
  "claude-haiku-5-5": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
  "longcat-2.5-preview-free": [],
  "step-5-preview-free": ["low", "medium", "high"],
} as const;

export type ThinkingLevel = (typeof MODEL_VARIANTS)[keyof typeof MODEL_VARIANTS][number];

export interface SharedMemoryConfig {
  readonly read: readonly string[];
  readonly write: readonly string[];
}
export interface BudgetConfig {
  tokens?: number;
  usd?: number;
}

export interface BotConfig {
  readonly model: ModelDecl;
  readonly thinkingLevel?: ThinkingLevel;
  readonly systemPrompt: string;
  readonly brief?: string;
  readonly delegatesTo?: string[];
  readonly sharedMemory?: SharedMemoryConfig;
  readonly budgets?: BudgetConfig;
}

const VARIANT_INDEX = new Map<string, readonly ThinkingLevel[]>(Object.entries(MODEL_VARIANTS));
const ALL_THINKING_LEVELS = new Set<string>(Object.values(MODEL_VARIANTS).flat());
const KNOWN_MODEL_IDS = Object.keys(MODEL_VARIANTS).join(", ");

const isString = Schema.is(Schema.String);
const isNumber = Schema.is(Schema.Number);
const isObject = (value: RawJson | undefined): value is RawObject =>
  Object.prototype.toString.call(value) === "[object Object]";

const isThinkingLevel = (value: RawJson | undefined): value is ThinkingLevel =>
  isString(value) && ALL_THINKING_LEVELS.has(value);

const field = (raw: RawObject, key: string): RawJson | undefined =>
  Object.hasOwn(raw, key) ? raw[key] : undefined;

const fail = (message: string): Effect.Effect<never, Error> =>
  Effect.fail(new Error(`bots.json: ${message}`));

const requireField = (
  botId: string,
  raw: RawObject,
  key: string,
): Effect.Effect<RawJson, Error> => {
  const value = field(raw, key);
  return value === undefined ? fail(`bot "${botId}" is missing "${key}"`) : Effect.succeed(value);
};

const decodeText = (botId: string, key: string, value: RawJson): Effect.Effect<string, Error> => {
  if (!isString(value) || value.trim().length === 0) {
    return fail(`bot "${botId}" field "${key}" must be a non-empty string`);
  }
  return Effect.succeed(value);
};

const assertKnownOpenCodeModel = (botId: string, modelId: string): Effect.Effect<void, Error> =>
  VARIANT_INDEX.has(modelId)
    ? Effect.void
    : fail(
        `bot "${botId}" model "${modelId}" is not in the OpenCode Go catalog. Known ids: ${KNOWN_MODEL_IDS}`,
      );

const openCodeModelId = (model: ModelDecl): string | undefined => {
  if (isString(model)) {
    return model.startsWith(WORKERS_AI_PREFIX) ? undefined : model;
  }
  return model.modelId;
};

const decodeModel = (botId: string, value: RawJson): Effect.Effect<ModelDecl, Error> =>
  Effect.gen(function* () {
    if (isString(value)) {
      const trimmed = value.trim();
      if (trimmed.startsWith(WORKERS_AI_PREFIX)) return trimmed;
      yield* assertKnownOpenCodeModel(botId, trimmed);
      return trimmed;
    }
    if (isObject(value)) {
      const provider = field(value, "provider");
      const modelId = field(value, "modelId");
      if (!isString(provider) || !isString(modelId)) {
        return yield* fail(
          `bot "${botId}" field "model" must be a string or an object with string "provider" and "modelId"`,
        );
      }
      if (provider !== OPENCODE_GO_PROVIDER_ID) {
        return yield* fail(
          `bot "${botId}" model.provider "${provider}" is not supported; use "${OPENCODE_GO_PROVIDER_ID}" or a "${WORKERS_AI_PREFIX}..." string`,
        );
      }
      const trimmed = modelId.trim();
      if (trimmed.length === 0)
        return yield* fail(`bot "${botId}" model.modelId must be a non-empty string`);
      yield* assertKnownOpenCodeModel(botId, trimmed);
      return { provider: OPENCODE_GO_PROVIDER_ID, modelId: trimmed };
    }
    return yield* fail(
      `bot "${botId}" field "model" must be a string or an object with string "provider" and "modelId"`,
    );
  });

const decodeThinkingLevel = (
  botId: string,
  model: ModelDecl,
  value: RawJson,
): Effect.Effect<ThinkingLevel, Error> =>
  Effect.gen(function* () {
    if (!isThinkingLevel(value)) {
      return yield* fail(
        `bot "${botId}" field "thinkingLevel" must be one of: ${[...ALL_THINKING_LEVELS].join(", ")}`,
      );
    }
    const modelId = openCodeModelId(model);
    if (modelId === undefined) return value;
    const variants = VARIANT_INDEX.get(modelId);
    if (variants === undefined) {
      return yield* fail(`bot "${botId}" model "${modelId}" is not in the OpenCode Go catalog`);
    }
    if (variants.length === 0) {
      return yield* fail(
        `bot "${botId}" model "${modelId}" has no thinking variants; omit "thinkingLevel"`,
      );
    }
    if (!variants.includes(value)) {
      return yield* fail(
        `bot "${botId}" thinkingLevel "${value}" is not supported by "${modelId}" (allowed: ${variants.join(", ")})`,
      );
    }
    return value;
  });

const decodeStringArray = (
  botId: string,
  key: string,
  value: RawJson,
): Effect.Effect<string[], Error> => {
  if (!Array.isArray(value)) {
    return fail(`bot "${botId}" field "${key}" must be an array of strings`);
  }
  const out: string[] = [];
  for (const entry of value) {
    if (!isString(entry) || entry.trim().length === 0) {
      return fail(`bot "${botId}" field "${key}" must contain non-empty strings`);
    }
    out.push(entry);
  }
  return Effect.succeed(out);
};

const decodeSharedMemory = (
  botId: string,
  value: RawJson,
): Effect.Effect<SharedMemoryConfig, Error> =>
  Effect.gen(function* () {
    if (!isObject(value))
      return yield* fail(`bot "${botId}" field "sharedMemory" must be an object`);
    const read = field(value, "read");
    if (read === undefined)
      return yield* fail(`bot "${botId}" field "sharedMemory.read" is required`);
    const write = field(value, "write");
    if (write === undefined)
      return yield* fail(`bot "${botId}" field "sharedMemory.write" is required`);
    return {
      read: yield* decodeStringArray(botId, "sharedMemory.read", read),
      write: yield* decodeStringArray(botId, "sharedMemory.write", write),
    };
  });

const decodeBudgets = (botId: string, value: RawJson): Effect.Effect<BudgetConfig, Error> =>
  Effect.gen(function* () {
    if (!isObject(value)) return yield* fail(`bot "${botId}" field "budgets" must be an object`);
    const result: BudgetConfig = {};
    const tokens = field(value, "tokens");
    if (tokens !== undefined) {
      if (!isNumber(tokens) || !Number.isFinite(tokens) || tokens < 0) {
        return yield* fail(`bot "${botId}" field "budgets.tokens" must be a non-negative number`);
      }
      result.tokens = tokens;
    }
    const usd = field(value, "usd");
    if (usd !== undefined) {
      if (!isNumber(usd) || !Number.isFinite(usd) || usd < 0) {
        return yield* fail(`bot "${botId}" field "budgets.usd" must be a non-negative number`);
      }
      result.usd = usd;
    }
    return result;
  });

interface DraftBotConfig {
  model: ModelDecl;
  systemPrompt: string;
  thinkingLevel?: ThinkingLevel;
  brief?: string;
  delegatesTo?: string[];
  sharedMemory?: SharedMemoryConfig;
  budgets?: BudgetConfig;
}

const decodeBot = (botId: string, raw: RawJson): Effect.Effect<BotConfig, Error> =>
  Effect.gen(function* () {
    if (!isObject(raw)) return yield* fail(`bot "${botId}" must be an object`);
    const config: DraftBotConfig = {
      model: yield* decodeModel(botId, yield* requireField(botId, raw, "model")),
      systemPrompt: yield* decodeText(
        botId,
        "systemPrompt",
        yield* requireField(botId, raw, "systemPrompt"),
      ),
    };
    const thinkingLevel = field(raw, "thinkingLevel");
    if (thinkingLevel !== undefined) {
      config.thinkingLevel = yield* decodeThinkingLevel(botId, config.model, thinkingLevel);
    }
    const brief = field(raw, "brief");
    if (brief !== undefined) {
      config.brief = yield* decodeText(botId, "brief", brief);
    }
    const delegatesTo = field(raw, "delegatesTo");
    if (delegatesTo !== undefined) {
      config.delegatesTo = yield* decodeStringArray(botId, "delegatesTo", delegatesTo);
    }
    const sharedMemory = field(raw, "sharedMemory");
    if (sharedMemory !== undefined) {
      config.sharedMemory = yield* decodeSharedMemory(botId, sharedMemory);
    }
    const budgets = field(raw, "budgets");
    if (budgets !== undefined) {
      config.budgets = yield* decodeBudgets(botId, budgets);
    }
    return config;
  });

const decodeRegistry = (raw: RawJson): Effect.Effect<Record<string, BotConfig>, Error> =>
  Effect.gen(function* () {
    if (!isObject(raw)) return yield* fail("the registry must be a JSON object keyed by bot id");
    const bots: Record<string, BotConfig> = {};
    for (const [botId, rawBot] of Object.entries(raw)) {
      if (botId.trim().length === 0) return yield* fail("bot ids must be non-empty strings");
      bots[botId] = yield* decodeBot(botId, rawBot);
    }
    if (Object.keys(bots).length === 0)
      return yield* fail("the registry is empty; declare at least one bot");
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
    return bots;
  });

export type BotRegistryParse =
  | { readonly ok: true; readonly bots: Record<string, BotConfig> }
  | { readonly ok: false; readonly error: string };

export function parseBotRegistry(raw: RawJson): BotRegistryParse {
  return Effect.runSync(
    decodeRegistry(raw).pipe(
      Effect.match({
        onSuccess: (bots): BotRegistryParse => ({ ok: true, bots }),
        onFailure: (error): BotRegistryParse => ({ ok: false, error: error.message }),
      }),
    ),
  );
}

let cached: Record<string, BotConfig> | undefined;

export function loadBots(): Record<string, BotConfig> {
  cached ??= (() => {
    // SAFETY: the bundled JSON import decodes to a JSON value at runtime.
    const parsed = parseBotRegistry(botsJson as RawJson);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.bots;
  })();
  return cached;
}

export function getBot(name: string): BotConfig {
  const bots = loadBots();
  if (!Object.hasOwn(bots, name)) {
    Effect.runSync(fail(`no bot "${name}". Declared bots: ${Object.keys(bots).join(", ")}`));
  }
  // SAFETY: hasOwn check above guarantees this key exists.
  return bots[name] as BotConfig;
}

export function resolveModelRef(bot: BotConfig): ModelRef {
  const model = bot.model;
  if (isString(model)) {
    return model.startsWith(WORKERS_AI_PREFIX)
      ? { provider: CLOUDFLARE_PROVIDER_ID, id: model }
      : { provider: OPENCODE_GO_PROVIDER_ID, id: model };
  }
  return { provider: OPENCODE_GO_PROVIDER_ID, id: model.modelId };
}
