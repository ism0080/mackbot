/**
 * Typed loader for the `bots.json` bot registry.
 *
 * `bots.json` is user-editable configuration, bundled at build time and decoded
 * once here. Every problem fails fast with a message naming the bot and the
 * field, because a bad registry means the whole fleet is misconfigured.
 *
 * ## Registry shape
 *
 * ```json
 * {
 *   "hermes": {
 *     "model": { "provider": "opencode-go", "modelId": "deepseek-v4-pro" },
 *     "thinkingLevel": "high",
 *     "systemPrompt": "You are ... (the bot's job, not the tool protocol) ...",
 *     "telegramTokenEnv": "TELEGRAM_TOKEN_HERMES",
 *     "telegramSecretTokenEnv": "TELEGRAM_SECRET_HERMES"
 *   }
 * }
 * ```
 *
 * One entry per bot, keyed by the bot id the front door routes on. Only `model`
 * and `systemPrompt` are required; `thinkingLevel` and the Telegram fields are
 * optional (that channel is added last, and the Telegram fields hold env var
 * *names*, never the tokens themselves).
 *
 * ## Models
 *
 * A `model` is either:
 *
 * - an object `{ "provider": "opencode-go", "modelId": "<id>" }` — OpenCode Go,
 *   where `OPENCODE_API_KEY` resolves from the environment; or
 * - a string. A string that starts with `@cf/` is a Workers AI model reached
 *   through the `AI` binding; any other string is shorthand for an OpenCode Go
 *   model id (e.g. the free `"longcat-2.5-preview-free"`).
 *
 * `resolveModelRef` turns either form into the `{ provider, id }` pair
 * pi-durable stores with a session. `agents`' `createAI(...).ai("@cf/…")`
 * builds its pi-ai models with `provider: "cloudflare"` (the
 * `CLOUDFLARE_PROVIDER_ID` in `agents/models/pi-ai`), and `PiHarness` reads
 * only a model's `provider` and `id`, so that is the provider an `@cf/` id
 * resolves to. OpenCode Go models resolve to `provider: "opencode-go"`.
 *
 * ## Thinking variants
 *
 * `thinkingLevel` must be one of the model's thinking variants, and the
 * variants differ per model — `deepseek-v4-pro` supports only `high`/`max`,
 * `glm-5.3` supports `low`/`high`/`max`, and the free models support none at
 * all. `MODEL_VARIANTS` is the OpenCode Go catalog subset a personal fleet is
 * likely to use (fetched 2026-10-14); an OpenCode Go model id outside it is a
 * configuration error, not something to guess about.
 */

import botsJson from "../bots.json";

/** A parsed JSON object, as `JSON.parse` (and a JSON module import) yields one. */
interface RawObject {
  readonly [key: string]: RawJson;
}
/** A parsed JSON value, as `JSON.parse` yields it. */
type RawJson = string | number | boolean | null | readonly RawJson[] | RawObject;

/**
 * The OpenCode Go provider id (`opencode-go`), used when a bot's model is an
 * OpenCode Go model.
 */
const OPENCODE_GO_PROVIDER_ID = "opencode-go";
/** The provider id `agents`' `createAI` uses for Workers AI (`@cf/…`) models. */
const CLOUDFLARE_PROVIDER_ID = "cloudflare";
/** Workers AI model ids always carry this prefix. */
const WORKERS_AI_PREFIX = "@cf/";

/** The OpenCode Go provider id a bot's model resolves to. */
export type ProviderId = typeof OPENCODE_GO_PROVIDER_ID | typeof CLOUDFLARE_PROVIDER_ID;

/**
 * A model reference as pi-durable stores it with a session: the model's
 * provider and id. Structurally matches `PiModel` from `agents/harness/pi`.
 */
export interface ModelRef {
  readonly provider: ProviderId;
  readonly id: string;
}

/** A bot's declared model: an OpenCode Go object or a model id string. */
export type ModelDecl =
  | string
  | { readonly provider: typeof OPENCODE_GO_PROVIDER_ID; readonly modelId: string };

/**
 * The thinking variants of the OpenCode Go models a personal fleet is likely to
 * use, from the catalog fetched 2026-10-14. An empty list means the model has no
 * variants, so `thinkingLevel` must be omitted.
 */
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

/** A thinking level accepted by a bot's `thinkingLevel`. */
export type ThinkingLevel = (typeof MODEL_VARIANTS)[keyof typeof MODEL_VARIANTS][number];

/** A validated bot declaration. */
/** Per-bot shared-memory access scopes. */
export interface SharedMemoryConfig {
  readonly read: readonly string[];
  readonly write: readonly string[];
}
/** Optional per-bot spend ceilings. */
export interface BudgetConfig {
  tokens?: number;
  usd?: number;
}

export interface BotConfig {
  readonly model: ModelDecl;
  readonly thinkingLevel?: ThinkingLevel;
  readonly systemPrompt: string;
  /**
   * The cron brief: the text an hourly routine submits to this bot. Optional —
   * a bot without one is skipped by the cron handler.
   */
  readonly brief?: string;
  /** Optional allowlist of bot ids this bot may delegate work to. */
  readonly delegatesTo?: string[];
  /** Optional shared-memory scopes this bot may read from / write to. */
  readonly sharedMemory?: SharedMemoryConfig;
  /** Optional soft caps on this bot's resource usage. */
  readonly budgets?: BudgetConfig;
  /** Name of the env var holding this bot's Telegram bot token. */
  readonly telegramTokenEnv?: string;
  /** Name of the env var holding this bot's Telegram webhook secret token. */
  readonly telegramSecretTokenEnv?: string;
}

const VARIANT_INDEX = new Map<string, readonly ThinkingLevel[]>(Object.entries(MODEL_VARIANTS));
const ALL_THINKING_LEVELS = new Set<string>(Object.values(MODEL_VARIANTS).flat());
const KNOWN_MODEL_IDS = Object.keys(MODEL_VARIANTS).join(", ");
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

const isString = (value: RawJson | undefined): value is string =>
  Object.prototype.toString.call(value) === "[object String]";

const isObject = (value: RawJson | undefined): value is RawObject =>
  Object.prototype.toString.call(value) === "[object Object]";
const isNumber = (value: RawJson | undefined): value is number =>
  Object.prototype.toString.call(value) === "[object Number]";

const isThinkingLevel = (value: RawJson | undefined): value is ThinkingLevel =>
  isString(value) && ALL_THINKING_LEVELS.has(value);

const field = (raw: RawObject, key: string): RawJson | undefined =>
  Object.hasOwn(raw, key) ? raw[key] : undefined;

const fail: (message: string) => never = (message) => {
  throw new Error(`bots.json: ${message}`);
};

const requireField = (botId: string, raw: RawObject, key: string): RawJson => {
  const value = field(raw, key);
  if (value === undefined) fail(`bot "${botId}" is missing "${key}"`);
  return value;
};

const decodeText = (botId: string, key: string, value: RawJson): string => {
  if (!isString(value) || value.trim().length === 0) {
    fail(`bot "${botId}" field "${key}" must be a non-empty string`);
  }
  return value;
};

const decodeEnvName = (botId: string, key: string, value: RawJson): string => {
  if (!isString(value) || !ENV_NAME_PATTERN.test(value)) {
    fail(
      `bot "${botId}" field "${key}" must be an environment variable name like TELEGRAM_TOKEN_HERMES`,
    );
  }
  return value;
};

const assertKnownOpenCodeModel = (botId: string, modelId: string): void => {
  if (!VARIANT_INDEX.has(modelId)) {
    fail(
      `bot "${botId}" model "${modelId}" is not in the OpenCode Go catalog. Known ids: ${KNOWN_MODEL_IDS}`,
    );
  }
};

const decodeModel = (botId: string, value: RawJson): ModelDecl => {
  if (isString(value)) {
    if (value.startsWith(WORKERS_AI_PREFIX)) return value;
    assertKnownOpenCodeModel(botId, value);
    return value;
  }
  if (isObject(value)) {
    const provider = field(value, "provider");
    const modelId = field(value, "modelId");
    if (!isString(provider) || !isString(modelId)) {
      fail(
        `bot "${botId}" field "model" must be a string or an object with string "provider" and "modelId"`,
      );
    }
    if (provider !== OPENCODE_GO_PROVIDER_ID) {
      fail(
        `bot "${botId}" model.provider "${provider}" is not supported; use "${OPENCODE_GO_PROVIDER_ID}" or a "${WORKERS_AI_PREFIX}..." string`,
      );
    }
    const trimmed = modelId.trim();
    if (trimmed.length === 0) fail(`bot "${botId}" model.modelId must be a non-empty string`);
    assertKnownOpenCodeModel(botId, trimmed);
    return { provider: OPENCODE_GO_PROVIDER_ID, modelId: trimmed };
  }
  fail(
    `bot "${botId}" field "model" must be a string or an object with string "provider" and "modelId"`,
  );
};

const decodeThinkingLevel = (botId: string, model: ModelDecl, value: RawJson): ThinkingLevel => {
  if (!isThinkingLevel(value)) {
    fail(
      `bot "${botId}" field "thinkingLevel" must be one of: ${[...ALL_THINKING_LEVELS].join(", ")}`,
    );
  }
  const modelId = openCodeModelId(model);
  if (modelId === undefined) return value;
  const variants = VARIANT_INDEX.get(modelId);
  if (variants === undefined) {
    fail(`bot "${botId}" model "${modelId}" is not in the OpenCode Go catalog`);
  }
  if (variants.length === 0) {
    fail(`bot "${botId}" model "${modelId}" has no thinking variants; omit "thinkingLevel"`);
  }
  if (!variants.includes(value)) {
    fail(
      `bot "${botId}" thinkingLevel "${value}" is not supported by "${modelId}" (allowed: ${variants.join(", ")})`,
    );
  }
  return value;
};

/** The OpenCode Go model id a declaration names, or undefined for Workers AI. */
const openCodeModelId = (model: ModelDecl): string | undefined => {
  if (isString(model)) {
    return model.startsWith(WORKERS_AI_PREFIX) ? undefined : model;
  }
  return model.modelId;
};

interface DraftBotConfig {
  model: ModelDecl;
  systemPrompt: string;
  thinkingLevel?: ThinkingLevel;
  brief?: string;
  delegatesTo?: string[];
  sharedMemory?: SharedMemoryConfig;
  budgets?: BudgetConfig;
  telegramTokenEnv?: string;
  telegramSecretTokenEnv?: string;
}

const decodeStringArray = (botId: string, key: string, value: RawJson): string[] => {
  if (!Array.isArray(value)) {
    fail(`bot "${botId}" field "${key}" must be an array of strings`);
  }
  const out: string[] = [];
  for (const entry of value) {
    if (!isString(entry) || entry.trim().length === 0) {
      fail(`bot "${botId}" field "${key}" must contain non-empty strings`);
    }
    out.push(entry);
  }
  return out;
};

const decodeSharedMemory = (
  botId: string,
  value: RawJson,
): SharedMemoryConfig => {
  if (!isObject(value)) fail(`bot "${botId}" field "sharedMemory" must be an object`);
  const read = field(value, "read");
  if (read === undefined) fail(`bot "${botId}" field "sharedMemory.read" is required`);
  const write = field(value, "write");
  if (write === undefined) fail(`bot "${botId}" field "sharedMemory.write" is required`);
  return {
    read: decodeStringArray(botId, "sharedMemory.read", read),
    write: decodeStringArray(botId, "sharedMemory.write", write),
  };
};

const decodeBudgets = (botId: string, value: RawJson): BudgetConfig => {
  if (!isObject(value)) fail(`bot "${botId}" field "budgets" must be an object`);
  const result: BudgetConfig = {};
  const tokens = field(value, "tokens");
  if (tokens !== undefined) {
    if (!isNumber(tokens) || !Number.isFinite(tokens) || tokens < 0) {
      fail(`bot "${botId}" field "budgets.tokens" must be a non-negative number`);
    }
    result.tokens = tokens;
  }
  const usd = field(value, "usd");
  if (usd !== undefined) {
    if (!isNumber(usd) || !Number.isFinite(usd) || usd < 0) {
      fail(`bot "${botId}" field "budgets.usd" must be a non-negative number`);
    }
    result.usd = usd;
  }
  return result;
};

const decodeBot = (botId: string, raw: RawJson): BotConfig => {
  if (!isObject(raw)) fail(`bot "${botId}" must be an object`);
  const config: DraftBotConfig = {
    model: decodeModel(botId, requireField(botId, raw, "model")),
    systemPrompt: decodeText(botId, "systemPrompt", requireField(botId, raw, "systemPrompt")),
  };
  const thinkingLevel = field(raw, "thinkingLevel");
  if (thinkingLevel !== undefined) {
    config.thinkingLevel = decodeThinkingLevel(botId, config.model, thinkingLevel);
  }
  const brief = field(raw, "brief");
  if (brief !== undefined) {
    config.brief = decodeText(botId, "brief", brief);
  }
  const delegatesTo = field(raw, "delegatesTo");
  if (delegatesTo !== undefined) {
    config.delegatesTo = decodeStringArray(botId, "delegatesTo", delegatesTo);
  }
  const sharedMemory = field(raw, "sharedMemory");
  if (sharedMemory !== undefined) {
    config.sharedMemory = decodeSharedMemory(botId, sharedMemory);
  }
  const budgets = field(raw, "budgets");
  if (budgets !== undefined) {
    config.budgets = decodeBudgets(botId, budgets);
  }
  const telegramTokenEnv = field(raw, "telegramTokenEnv");
  if (telegramTokenEnv !== undefined) {
    config.telegramTokenEnv = decodeEnvName(botId, "telegramTokenEnv", telegramTokenEnv);
  }
  const telegramSecretTokenEnv = field(raw, "telegramSecretTokenEnv");
  if (telegramSecretTokenEnv !== undefined) {
    config.telegramSecretTokenEnv = decodeEnvName(
      botId,
      "telegramSecretTokenEnv",
      telegramSecretTokenEnv,
    );
  }
  return config;
};

const decodeRegistry = (raw: RawJson) => {
  if (!isObject(raw)) fail("the registry must be a JSON object keyed by bot id");
  const bots: Record<string, BotConfig> = {};
  for (const [botId, rawBot] of Object.entries(raw)) {
    if (botId.trim().length === 0) fail("bot ids must be non-empty strings");
    bots[botId] = decodeBot(botId, rawBot);
  }
  if (Object.keys(bots).length === 0) fail("the registry is empty; declare at least one bot");
  return bots;
};

let cached: Record<string, BotConfig> | undefined;

/**
 * Validates and returns the bundled bot registry, keyed by bot id. Throws on the
 * first problem found, with a message naming the bot and field.
 */
export function loadBots(): Record<string, BotConfig> {
  cached ??= decodeRegistry(botsJson);
  return cached;
}

/**
 * Returns one bot's validated config. Throws if the registry has no such bot,
 * naming the bots it does have.
 */
export function getBot(name: string): BotConfig {
  const bots = loadBots();
  if (!Object.hasOwn(bots, name)) {
    fail(`no bot "${name}". Declared bots: ${Object.keys(bots).join(", ")}`);
  }
  return bots[name];
}

/**
 * Maps a bot's model declaration to the `{ provider, id }` pair pi-durable
 * stores with a session: `cloudflare` for `@cf/…` Workers AI ids,
 * `opencode-go` for everything else.
 */
export function resolveModelRef(bot: BotConfig): ModelRef {
  const model = bot.model;
  if (isString(model)) {
    return model.startsWith(WORKERS_AI_PREFIX)
      ? { provider: CLOUDFLARE_PROVIDER_ID, id: model }
      : { provider: OPENCODE_GO_PROVIDER_ID, id: model };
  }
  return { provider: OPENCODE_GO_PROVIDER_ID, id: model.modelId };
}
