/**
 * schema — Effect Schema definitions shared across mackbot modules.
 */

import * as Schema from "effect/Schema";

const trimmedNonEmpty = Schema.String.check(
  Schema.makeFilter((input: string) => input.trim().length > 0),
);

export const ChatRequestSchema = Schema.Struct({
  text: trimmedNonEmpty,
  operationId: Schema.optional(Schema.NonEmptyString),
  whenBusy: Schema.optional(Schema.Literals(["followUp", "steer"])),
  wait: Schema.optional(Schema.Boolean),
  conversation: Schema.optional(trimmedNonEmpty),
  thread: Schema.optional(trimmedNonEmpty),
});

export type ChatRequest = Schema.Schema.Type<typeof ChatRequestSchema>;

const opencodeGoProvider = Schema.Literal("opencode-go");

export const ModelRefSchema = Schema.Struct({
  provider: Schema.String,
  id: Schema.String,
});

export type ModelRef = Schema.Schema.Type<typeof ModelRefSchema>;

export const BotModelSchema = Schema.Union([
  Schema.String,
  Schema.Struct({
    provider: opencodeGoProvider,
    modelId: Schema.String,
  }),
]);

export type BotModel = Schema.Schema.Type<typeof BotModelSchema>;

export const SharedMemoryConfigSchema = Schema.Struct({
  read: Schema.Array(Schema.String),
  write: Schema.Array(Schema.String),
});

export type SharedMemoryConfig = Schema.Schema.Type<typeof SharedMemoryConfigSchema>;

export const BudgetConfigSchema = Schema.Struct({
  tokens: Schema.optional(Schema.Number),
  usd: Schema.optional(Schema.Number),
});

export type BudgetConfig = Schema.Schema.Type<typeof BudgetConfigSchema>;

export const BotConfigSchema = Schema.Struct({
  model: BotModelSchema,
  thinkingLevel: Schema.optional(Schema.String),
  systemPrompt: Schema.String,
  brief: Schema.optional(Schema.String),
  delegatesTo: Schema.optional(Schema.Array(Schema.String)),
  sharedMemory: Schema.optional(SharedMemoryConfigSchema),
  budgets: Schema.optional(BudgetConfigSchema),
  telegramTokenEnv: Schema.optional(Schema.String),
  telegramSecretTokenEnv: Schema.optional(Schema.String),
});

export type BotConfig = Schema.Schema.Type<typeof BotConfigSchema>;

export const EnvSchema = Schema.Struct({
  Bot: Schema.Unknown,
  AI: Schema.Unknown,
  EXECUTOR_URL: Schema.String,
  EXECUTOR_TOKEN: Schema.String,
  OPENCODE_API_KEY: Schema.String,
  CHAT_BEARER_TOKEN: Schema.String,
});

export type Env = Schema.Schema.Type<typeof EnvSchema>;

export const EnvValuesSchema = Schema.Struct({
  EXECUTOR_URL: Schema.String,
  EXECUTOR_TOKEN: Schema.String,
  OPENCODE_API_KEY: Schema.String,
  CHAT_BEARER_TOKEN: Schema.String,
});

export type EnvValues = Schema.Schema.Type<typeof EnvValuesSchema>;

export const decodeChatRequest = Schema.decodeUnknownSync(ChatRequestSchema);
export const parseChatRequest = Schema.decodeUnknownEffect(ChatRequestSchema);

export const decodeBotModel = Schema.decodeUnknownSync(BotModelSchema);
export const parseBotModel = Schema.decodeUnknownEffect(BotModelSchema);

export const decodeSharedMemoryConfig = Schema.decodeUnknownSync(SharedMemoryConfigSchema);
export const parseSharedMemoryConfig = Schema.decodeUnknownEffect(SharedMemoryConfigSchema);

export const decodeBudgetConfig = Schema.decodeUnknownSync(BudgetConfigSchema);
export const parseBudgetConfig = Schema.decodeUnknownEffect(BudgetConfigSchema);

export const decodeBotConfig = Schema.decodeUnknownSync(BotConfigSchema);
export const parseBotConfig = Schema.decodeUnknownEffect(BotConfigSchema);

export const decodeEnv = Schema.decodeUnknownSync(EnvSchema);
export const parseEnv = Schema.decodeUnknownEffect(EnvSchema);

export const decodeEnvValues = Schema.decodeUnknownSync(EnvValuesSchema);
export const parseEnvValues = Schema.decodeUnknownEffect(EnvValuesSchema);

export const ModelDeclSchema = BotModelSchema;
export const decodeModelDecl = Schema.decodeUnknownSync(BotModelSchema);
export const decodeModel = decodeBotModel;
export const decodeSharedMemory = decodeSharedMemoryConfig;
export const decodeBudgets = decodeBudgetConfig;
export const decodeBudget = decodeBudgetConfig;

export {
  ChatRequestSchema as ChatRequestBodySchema,
  decodeChatRequest as readChatRequest,
};
