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
import { botOf, createRegistryStore, decideWrite, readOrSeed } from "./registry-store.ts";
import type { RegistryStore, RegistryWrite } from "./registry-store.ts";
import type { Env } from "./index.ts";

/** The bundled seed file breaks a rule: the Worker was built with a roster it cannot run. */
export class InvalidSeedRoster extends Schema.TaggedError<InvalidSeedRoster>()(
  "InvalidSeedRoster",
  { message: Schema.String },
) {}

/**
 * The seed roster: the bots the bundled file declares.
 *
 * The file is the seed, not a second source for the same fact. A registry
 * that has been seeded reads it no more, and the registry is the only truth
 * from then on. The seed is read inside the storage transaction's callback,
 * so a broken file is thrown there and rolls the transaction back.
 */
export const seedBots = (): Record<string, BotConfig> => {
  const parsed = parseBotRegistry(botsJson);
  if (!parsed.ok) {
    throw new InvalidSeedRoster({ message: `bots.json: ${parsed.error}` });
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
  /**
   * The roster as last read or written. This object is the table's only
   * writer, so the copy goes stale only through {@link put}, which replaces
   * it; every route's read is then answered without touching SQLite.
   */
  #roster: Record<string, BotConfig> | undefined;
  /** Bumped by every write, so a read that a write overtook is not cached. */
  #writes = 0;

  #registry(): RegistryStore {
    this.#store ??= createRegistryStore({ sql: this.ctx.storage.sql });
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
    if (this.#roster !== undefined) return this.#roster;
    const writes = this.#writes;
    const bots = await this.ctx.storage.transaction(async () => {
      const store = this.#registry();
      return await readOrSeed(store, seedBots);
    });
    if (writes === this.#writes) this.#roster = bots;
    return bots;
  }

  /** One bot, or nothing when the registry does not declare it. */
  async bot(id: string): Promise<BotConfig | undefined> {
    return botOf(await this.roster(), id);
  }

  /**
   * Several bots in one call, keyed by id; an id the registry does not
   * declare is absent. A caller that needs more than one bot's configuration
   * asks once instead of once per bot.
   */
  async bots(ids: readonly string[]): Promise<Record<string, BotConfig>> {
    const roster = await this.roster();
    const found: Record<string, BotConfig> = {};
    for (const id of ids) {
      const bot = botOf(roster, id);
      if (bot !== undefined) found[id] = bot;
    }
    return found;
  }

  /**
   * The one write.
   *
   * The read, the decision and the write are one atomic step: a write that
   * the rules refuse returns the refusal and changes nothing.
   */
  async put(id: string, bot: BotConfig, mode: "create" | "replace"): Promise<RegistryWrite> {
    const written = await this.ctx.storage.transaction(async (): Promise<RegistryWrite> => {
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
    // Dropped rather than replaced on a refusal too, so the next read is the
    // table's own answer whatever the transaction did.
    this.#writes += 1;
    this.#roster = written.ok ? written.roster : undefined;
    return written;
  }
}
