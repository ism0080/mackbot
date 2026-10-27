/**
 * registry — the `Registry` Durable Object, the roster's one owner.
 *
 * The roster is a fleet-wide fact, so it has one owner: this Durable Object,
 * one instance named `registry`, holds one table of bots and is the only
 * writer. A write reads the roster, applies the change, applies the rules and
 * writes, all inside one storage transaction, so two writes cannot lose one
 * another and a refused write leaves the roster exactly as it was.
 *
 * `bots.json` seeds the registry when the table is empty, which is a fresh
 * registry and nothing else: the roster may not be empty and delete is not
 * offered. After the seed the registry is authoritative and the file is
 * inert.
 *
 * The class is exported from `src/index.ts`, because the Worker entry module
 * is where Cloudflare looks for a Durable Object class and the class name has
 * to match the binding name.
 */

import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import botsJson from "../bots.json";
import { BotConfigSchema, BotIdSchema } from "@mackbot/contract";
import { parseBotRegistry } from "./bots.ts";
import type { BotConfig } from "./bots.ts";
import { createRegistryStore, decideWrite, readOrSeed } from "./registry-store.ts";
import type { RegistryStore, RegistryWrite } from "./registry-store.ts";
import type { Env } from "./index.ts";

/**
 * The seed roster: the bots the bundled file declares.
 *
 * The file is the seed, not a second source for the same fact. A registry
 * that has been seeded reads it no more, and the registry is the only truth
 * from then on.
 */
export const seedBots = (): Record<string, BotConfig> => {
  const parsed = parseBotRegistry(botsJson);
  if (!parsed.ok) {
    throw new Error(`bots.json: ${parsed.error}`);
  }
  return parsed.bots;
};

/**
 * A bot as the contract reads it, or the reason it cannot be read.
 */
type DecodedBot =
  | { readonly ok: true; readonly bot: BotConfig }
  | { readonly ok: false; readonly error: string };

/**
 * A bot's id and configuration, read with the contract's schemas.
 *
 * The Durable Object's RPC surface is reachable without the front door's
 * schema, so the shape is checked here as well: a bot that cannot be decoded
 * is a write that is refused, not a row that is stored half-built.
 */
const decodeBot = async (id: string, bot: BotConfig): Promise<DecodedBot> =>
  await Effect.runPromise(
    Effect.gen(function* () {
      // The id is the Durable Object's name, the path segment the routes carry
      // it in and the key its transcript is filed under, so it is a slug.
      yield* Schema.decodeUnknownEffect(BotIdSchema)(id);
      const decoded = yield* Schema.decodeUnknownEffect(BotConfigSchema)(bot);
      return { ok: true as const, bot: decoded };
    }).pipe(
      Effect.match({
        onSuccess: (decoded): DecodedBot => ({ ok: true, bot: decoded.bot }),
        onFailure: (error): DecodedBot => ({ ok: false, error: error.message }),
      }),
    ),
  );

export class Registry extends DurableObject<Env> {
  #store: RegistryStore | undefined;

  #registry(): RegistryStore {
    this.#store ??= createRegistryStore({
      sql: this.ctx.storage.sql,
      // The Durable Object's transaction hands the closure its transaction
      // object; the store's closure needs nothing but the storage it holds.
      transaction: (closure) => this.ctx.storage.transaction(() => closure()),
    });
    return this.#store;
  }

  /**
   * Every bot the fleet runs.
   *
   * A registry that has never been seeded takes its bots from the bundled
   * file, so the first read of a fresh registry answers with the seeded
   * roster rather than with nothing.
   */
  async roster(): Promise<Record<string, BotConfig>> {
    return await this.ctx.storage.transaction(async () => {
      const store = this.#registry();
      return await readOrSeed(store, seedBots);
    });
  }

  /** One bot, or nothing when the registry does not declare it. */
  async bot(id: string): Promise<BotConfig | undefined> {
    const bots = await this.roster();
    return bots[id];
  }

  /**
   * The one write.
   *
   * The read, the decision and the write are one atomic step: a write that
   * the rules refuse returns the refusal and changes nothing.
   */
  async put(id: string, bot: BotConfig, mode: "create" | "replace"): Promise<RegistryWrite> {
    return await this.ctx.storage.transaction(async () => {
      const store = this.#registry();
      const current = await readOrSeed(store, seedBots);
      // The shape is checked before the rules, because the rules read the
      // shape: a configuration that never decoded has no model to look up.
      const decoded = await decodeBot(id, bot);
      if (!decoded.ok) {
        return { ok: false, roster: null, code: "invalid", error: decoded.error };
      }
      const decision = await decideWrite(current, id, decoded.bot, mode);
      if (!decision.ok) return decision;
      await store.write(id, decoded.bot);
      return { ok: true, roster: decision.roster, code: null, error: null };
    });
  }
}
