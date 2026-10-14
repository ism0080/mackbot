/**
 * Effect-based application configuration.
 *
 * Reads the Worker/DO environment through `effect/Config` (env vars resolve via
 * the active `ConfigProvider`, defaulting to `process.env` under `nodejs_compat`).
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";

export interface AppConfigValues {
  readonly EXECUTOR_URL: string;
  readonly EXECUTOR_TOKEN: string;
  readonly OPENCODE_API_KEY: string;
  readonly CHAT_BEARER_TOKEN: string;
  readonly EXECUTOR_TIMEOUT_MS: number;
  readonly EXECUTOR_CONNECT_TIMEOUT_MS: number;
  // Convenience aliases.
  readonly executorUrl: string;
  readonly executorToken: string;
  readonly opencodeApiKey: string;
  readonly chatBearerToken: string;
}

const build = (values: {
  readonly executorUrl: string;
  readonly executorToken: string;
  readonly opencodeApiKey: string;
  readonly chatBearerToken: string;
  readonly executorTimeoutMs: number;
  readonly executorConnectTimeoutMs: number;
}): AppConfigValues => ({
  EXECUTOR_URL: values.executorUrl,
  EXECUTOR_TOKEN: values.executorToken,
  OPENCODE_API_KEY: values.opencodeApiKey,
  CHAT_BEARER_TOKEN: values.chatBearerToken,
  EXECUTOR_TIMEOUT_MS: values.executorTimeoutMs,
  EXECUTOR_CONNECT_TIMEOUT_MS: values.executorConnectTimeoutMs,
  executorUrl: values.executorUrl,
  executorToken: values.executorToken,
  opencodeApiKey: values.opencodeApiKey,
  chatBearerToken: values.chatBearerToken,
});

export const config: Effect.Effect<AppConfigValues, Config.ConfigError> = Effect.gen(function* () {
  const executorUrl = yield* Config.NonEmptyString("EXECUTOR_URL");
  const executorToken = yield* Config.NonEmptyString("EXECUTOR_TOKEN");
  const opencodeApiKey = yield* Config.NonEmptyString("OPENCODE_API_KEY");
  const chatBearerToken = yield* Config.NonEmptyString("CHAT_BEARER_TOKEN");
  const executorTimeoutMs = yield* Config.Int("EXECUTOR_TIMEOUT_MS").pipe(
    Config.withDefault(30_000),
  );
  const executorConnectTimeoutMs = yield* Config.Int("EXECUTOR_CONNECT_TIMEOUT_MS").pipe(
    Config.withDefault(10_000),
  );
  return build({
    executorUrl,
    executorToken,
    opencodeApiKey,
    chatBearerToken,
    executorTimeoutMs,
    executorConnectTimeoutMs,
  });
});

export const loadConfig = (): Effect.Effect<AppConfigValues, Config.ConfigError> => config;
export const readConfig = loadConfig;

export class AppConfig extends Context.Service<AppConfig, AppConfigValues>()("AppConfig") {}

export const AppConfigLive = Layer.effect(AppConfig, config).pipe(
  Layer.provide(Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv())),
);

export const ConfigService = AppConfig;
export const Configuration = AppConfig;
export const configuration = config;
export const configService = config;

export function runSync(): AppConfigValues;
export function runSync<A, E, R>(effect: Effect.Effect<A, E, R>): A;
export function runSync<A = AppConfigValues>(effect?: Effect.Effect<A, unknown, unknown>): A {
  const provider = ConfigProvider.fromEnv();
  if (effect === undefined) {
    // SAFETY: `config` yields `AppConfigValues`; widening to caller's `A` only in generic overload fallback.
    return Effect.runSync(config.pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider))) as A;
  }
  // SAFETY: Effect Composition guarantees type erasure only; caller supplies effect.
  return Effect.runSync(effect as Effect.Effect<A, unknown, never>) as A;
}

export type Configuration = AppConfigValues;
export type ConfigService = AppConfigValues;
