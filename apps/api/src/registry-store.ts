/**
 * registry-store — the roster's table, and the decision a write makes.
 *
 * The roster is a record of bot configurations keyed by bot id. One row per
 * bot, so a write touches one bot's row and nothing else, and the rules that
 * span the whole roster are applied by the Durable Object that owns the table,
 * inside one transaction, so two writes cannot lose one another.
 *
 * The store is the seam over `SqlExecutor`, so the same code runs against a
 * Durable Object's SQLite in production and against `bun:sqlite` in the smoke
 * tests, with no cast in either. A row's `spec` is the bot's configuration as
 * JSON, read back with the contract's schema: a row that cannot be decoded
 * fails loudly instead of becoming a half-built bot.
 *
 * The write decision is a pure function of the roster, the bot's id, the bot's
 * configuration and whether the write creates or replaces. Keeping it out of
 * the Durable Object is what lets it be exercised on its own.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { BotConfigSchema } from "@mackbot/contract";
import type { BotConfig } from "@mackbot/contract";
import { checkBotConfig, validateRoster } from "./bots.ts";
import { read as readRows, write as writeRow } from "./sql.ts";
import type { SqlExecutor } from "./sql.ts";

const CREATE_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS mackbot_bots (id TEXT PRIMARY KEY, spec TEXT NOT NULL)";

const SELECT_ALL_SQL = "SELECT id, spec FROM mackbot_bots";

const UPSERT_SQL = "INSERT OR REPLACE INTO mackbot_bots (id, spec) VALUES (?, ?)";

/** A row's `spec`: the bot's configuration, as the contract reads it. */
const SpecSchema = Schema.fromJsonString(BotConfigSchema);

/**
 * The storage the store reads and writes through. The read-modify-write is
 * made one step by the Durable Object that owns the table, which wraps it in
 * its own transaction.
 */
export interface RegistryStorage {
  readonly sql: SqlExecutor;
}

export interface RegistryStore {
  /** Create the table. Idempotent. */
  readonly migrate: () => Promise<void>;
  /** Every bot, keyed by id. */
  readonly read: () => Promise<Record<string, BotConfig>>;
  /** Insert or replace one bot's row. */
  readonly write: (id: string, bot: BotConfig) => Promise<void>;
}

/**
 * The refusals a write can answer with.
 */
export type RegistryRefusal = "invalid" | "unknown" | "exists";

/**
 * What a write decided.
 *
 * `invalid` is a rule's own refusal, `unknown` is a bot that is not there and
 * `exists` is a bot that already is. The front door turns each into its own
 * status code.
 *
 * Both branches carry the same fields, because the answer crosses the Durable
 * Object's RPC boundary, where a union is typed as the intersection of its
 * branches: a field that only one branch has would be lost on the way.
 */
export type RegistryWrite =
  | {
      readonly ok: true;
      readonly roster: Record<string, BotConfig>;
      readonly code: null;
      readonly error: null;
    }
  | {
      readonly ok: false;
      readonly roster: null;
      readonly code: RegistryRefusal;
      readonly error: string;
    };

/**
 * A row's configuration, read back with the contract's schema.
 *
 * A row that cannot be read is a broken registry, not a bot to work around, so
 * the failure names the bot whose row it was.
 */
const decodeSpec = (id: string, spec: string): Effect.Effect<BotConfig, Error> =>
  Schema.decodeUnknownEffect(SpecSchema)(spec).pipe(
    Effect.mapError(
      (cause) =>
        new Error(`bot "${id}" has a configuration this Worker cannot read: ${cause.message}`),
    ),
  );

export const createRegistryStore = (storage: RegistryStorage): RegistryStore => {
  const executor: SqlExecutor = storage.sql;
  let migrated = false;

  // The table is created lazily, so a fresh registry can be read before it is
  // written, and the write is idempotent for the same reason.
  const ensureMigrated = (): void => {
    if (migrated) return;
    writeRow(executor, CREATE_TABLE_SQL);
    migrated = true;
  };

  const readAll = (): Effect.Effect<Record<string, BotConfig>, Error> =>
    Effect.gen(function* () {
      ensureMigrated();
      const bots: Array<readonly [string, BotConfig]> = [];
      for (const row of readRows(executor, SELECT_ALL_SQL)) {
        const id = String(row.id);
        bots.push([id, yield* decodeSpec(id, String(row.spec))]);
      }
      // `fromEntries` defines own properties, so no id can reach the prototype.
      return Object.fromEntries(bots);
    });

  return {
    migrate: async () => {
      ensureMigrated();
    },
    read: () => Effect.runPromise(readAll()),
    write: async (id: string, bot: BotConfig) => {
      ensureMigrated();
      writeRow(executor, UPSERT_SQL, id, JSON.stringify(bot));
    },
  };
};

/**
 * One bot of a roster, or nothing when the roster does not declare it. The
 * roster is a plain record keyed by an id a client chose, so only its own keys
 * count: `constructor` or `__proto__` would otherwise name a bot.
 */
export const botOf = (
  roster: Readonly<Record<string, BotConfig>>,
  id: string,
): BotConfig | undefined => (Object.hasOwn(roster, id) ? roster[id] : undefined);

/**
 * The roster, seeded when the table is empty.
 *
 * An empty table is a fresh registry: the roster may not be empty and delete is
 * not offered, so there is no other way for a registry to be empty. The seed
 * is a function, so the bundled file is read only while the registry is empty
 * and is inert once the registry has a roster of its own.
 */
export const readOrSeed = async (
  store: RegistryStore,
  seed: () => Record<string, BotConfig>,
): Promise<Record<string, BotConfig>> => {
  const bots = await store.read();
  if (Object.keys(bots).length > 0) return bots;
  for (const [id, bot] of Object.entries(seed())) {
    await store.write(id, bot);
  }
  return await store.read();
};

/**
 * The decision one write makes, as a pure function of the roster it would
 * change.
 *
 * A create over an id that is already declared is `exists`, a replace of an id
 * that is not declared is `unknown`, and a bot that breaks a rule is `invalid`
 * with the rule's own message. The rules are the ones in `src/bots.ts`, so a
 * write from the browser is held to the same standard as the seed file.
 */
export const decideWrite = async (
  roster: Readonly<Record<string, BotConfig>>,
  id: string,
  bot: BotConfig,
  mode: "create" | "replace",
): Promise<RegistryWrite> => {
  const declared = Object.hasOwn(roster, id);
  if (mode === "create" && declared) {
    return {
      ok: false,
      roster: null,
      code: "exists",
      error: `bot "${id}" already exists`,
    };
  }
  if (mode === "replace" && !declared) {
    return { ok: false, roster: null, code: "unknown", error: `unknown bot "${id}"` };
  }
  const next = { ...roster, [id]: bot };
  return await Effect.runPromise(
    Effect.gen(function* () {
      yield* checkBotConfig(id, bot);
      yield* validateRoster(next);
      return next;
    }).pipe(
      Effect.match({
        onSuccess: (written): RegistryWrite => ({
          ok: true,
          roster: written,
          code: null,
          error: null,
        }),
        onFailure: (error): RegistryWrite => ({
          ok: false,
          roster: null,
          code: "invalid",
          error: error.message,
        }),
      }),
    ),
  );
};
