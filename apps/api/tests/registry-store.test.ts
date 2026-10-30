import { describe, expect, test } from "vitest";

import type { BotConfig } from "@mackbot/contract";

import { botOf, createRegistryStore, readOrSeed } from "../src/registry-store.ts";
import { createDelegationPolicy } from "../src/services/delegation.ts";
import { memoryStorage } from "./support/sqlite.ts";

const bot = (overrides: Partial<BotConfig> = {}): BotConfig => ({
  model: "deepseek-v4-pro",
  systemPrompt: "You are a test bot.",
  ...overrides,
});

describe("createRegistryStore", () => {
  test("reads back what it wrote, one row per bot", async () => {
    const store = createRegistryStore(memoryStorage());
    await store.write("alpha", bot({ delegatesTo: ["beta"] }));
    await store.write("beta", bot({ thinkingLevel: "high" }));
    await store.write("alpha", bot({ brief: "Morning." }));

    expect(await store.read()).toEqual({
      alpha: bot({ brief: "Morning." }),
      beta: bot({ thinkingLevel: "high" }),
    });
  });

  test("fails loudly on a row it cannot decode, naming the bot", async () => {
    const storage = memoryStorage();
    const store = createRegistryStore(storage);
    await store.migrate();
    storage.db.prepare("INSERT INTO mackbot_bots (id, spec) VALUES (?, ?)").run("broken", "{");
    await expect(store.read()).rejects.toThrow('bot "broken"');
  });

  test("a row keyed __proto__ stays a row and never becomes the roster's prototype", async () => {
    const store = createRegistryStore(memoryStorage());
    await store.write("__proto__", bot());
    const roster = await store.read();
    expect(Object.keys(roster)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(roster)).toBe(Object.prototype);
  });
});

describe("readOrSeed", () => {
  test("seeds an empty registry and reads the seed back", async () => {
    const store = createRegistryStore(memoryStorage());
    let seeded = 0;
    const seed = () => {
      seeded += 1;
      return { alpha: bot() };
    };
    expect(await readOrSeed(store, seed)).toEqual({ alpha: bot() });
    expect(await readOrSeed(store, seed)).toEqual({ alpha: bot() });
    expect(seeded).toBe(1);
  });

  test("leaves a registry that has a roster of its own alone", async () => {
    const store = createRegistryStore(memoryStorage());
    await store.write("beta", bot());
    const roster = await readOrSeed(store, () => ({ alpha: bot() }));
    expect(Object.keys(roster)).toEqual(["beta"]);
  });
});

describe("botOf", () => {
  const roster = { alpha: bot() };

  test("finds a declared bot", () => {
    expect(botOf(roster, "alpha")).toEqual(bot());
  });

  test.each([["constructor"], ["toString"], ["__proto__"], ["hasOwnProperty"]])(
    "does not resolve the prototype key %s",
    (id) => {
      expect(botOf(roster, id)).toBeUndefined();
    },
  );
});

describe("createDelegationPolicy", () => {
  test("an absent delegatesTo allows every other bot", () => {
    const policy = createDelegationPolicy({ alpha: bot(), beta: bot(), gamma: bot() });
    expect(policy.allowedTargets("alpha")).toEqual(["beta", "gamma"]);
  });

  test("an empty delegatesTo allows none", () => {
    const policy = createDelegationPolicy({ alpha: bot({ delegatesTo: [] }), beta: bot() });
    expect(policy.canDelegate("alpha", "beta")).toBe(false);
  });

  test("a prototype key is not a source bot", () => {
    const policy = createDelegationPolicy({ alpha: bot() });
    expect(policy.allowedTargets("constructor")).toEqual([]);
  });
});
