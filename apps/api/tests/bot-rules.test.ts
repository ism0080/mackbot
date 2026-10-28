import { readFileSync } from "node:fs";

import * as Effect from "effect/Effect";
import { describe, expect, test } from "vitest";

import type { BotConfig } from "@mackbot/contract";

import type { RawJson } from "../src/bots.ts";
import { checkBotConfig, parseBotRegistry, resolveModelRef, validateRoster } from "../src/bots.ts";
import { decideWrite } from "../src/registry-store.ts";

/** Run a rule and return its refusal message, or `undefined` when it passes. */
const refusal = async (rule: Effect.Effect<void, Error>): Promise<string | undefined> => {
  try {
    await Effect.runPromise(rule);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const bot = (overrides: Partial<BotConfig> = {}): BotConfig => ({
  model: "deepseek-v4-pro",
  systemPrompt: "You are a test bot.",
  ...overrides,
});

const roster = (bots: Record<string, BotConfig>): Record<string, BotConfig> => bots;

describe("checkBotConfig", () => {
  test("accepts a catalog model", async () => {
    expect(await refusal(checkBotConfig("alpha", bot()))).toBeUndefined();
  });

  test("accepts any @cf/ model", async () => {
    expect(
      await refusal(checkBotConfig("alpha", bot({ model: "@cf/meta/llama-3.1-8b-instruct" }))),
    ).toBeUndefined();
  });

  test("rejects an unknown model and names it", async () => {
    const message = await refusal(checkBotConfig("alpha", bot({ model: "gpt-9-imaginary" })));
    expect(message).toContain("gpt-9-imaginary");
    expect(message).toContain("alpha");
  });

  test("accepts a thinking level the model supports", async () => {
    expect(
      await refusal(
        checkBotConfig("alpha", bot({ model: "deepseek-v4-pro", thinkingLevel: "high" })),
      ),
    ).toBeUndefined();
  });

  test("rejects a thinking level the model does not support and lists the allowed ones", async () => {
    const message = await refusal(
      checkBotConfig("alpha", bot({ model: "deepseek-v4-pro", thinkingLevel: "medium" })),
    );
    expect(message).toContain("medium");
    expect(message).toContain("high, max");
  });

  test.each([["kimi-k2.7-code"], ["longcat-2.5-preview-free"]])(
    "rejects any thinking level for the variant-less model %s",
    async (model) => {
      for (const level of ["none", "low", "high", "max"] as const) {
        const message = await refusal(
          checkBotConfig("alpha", bot({ model, thinkingLevel: level })),
        );
        expect(message).toContain('omit "thinkingLevel"');
      }
    },
  );

  test("accepts a Workers AI model with any thinking level", async () => {
    expect(
      await refusal(
        checkBotConfig(
          "alpha",
          bot({ model: "@cf/meta/llama-3.1-8b-instruct", thinkingLevel: "xhigh" }),
        ),
      ),
    ).toBeUndefined();
  });
});

describe("validateRoster", () => {
  test("rejects an empty roster", async () => {
    const message = await refusal(validateRoster({}));
    expect(message).toContain("empty");
  });

  test("rejects delegating to a bot that is not declared", async () => {
    const message = await refusal(
      validateRoster(roster({ alpha: bot({ delegatesTo: ["ghost"] }) })),
    );
    expect(message).toContain("ghost");
    expect(message).toContain("alpha");
  });

  test("rejects self-delegation", async () => {
    const message = await refusal(
      validateRoster(roster({ alpha: bot({ delegatesTo: ["alpha"] }) })),
    );
    expect(message).toContain("itself");
  });

  test("accepts a valid two-bot roster", async () => {
    expect(
      await refusal(
        validateRoster(
          roster({ alpha: bot({ delegatesTo: ["beta"] }), beta: bot({ model: "glm-5.3" }) }),
        ),
      ),
    ).toBeUndefined();
  });
});

describe("parseBotRegistry", () => {
  const realRegistry = (): RawJson => {
    // SAFETY: bots.json is the JSON document this test reads from disk; the
    // subject under test is what `parseBotRegistry` makes of it.
    return JSON.parse(readFileSync(new URL("../bots.json", import.meta.url), "utf8")) as RawJson;
  };

  test("accepts the shipped apps/api/bots.json shape", () => {
    const parsed = parseBotRegistry(realRegistry());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.bots).sort()).toEqual(["hermes", "scribe"]);
    expect(parsed.bots.hermes?.delegatesTo).toEqual(["scribe"]);
  });

  const nonObjectRoots: ReadonlyArray<readonly [string, RawJson]> = [
    ["an array", []],
    ["a string", "nope"],
  ];

  test.each(nonObjectRoots)("rejects a non-object root: %s", (_label, raw) => {
    const parsed = parseBotRegistry(raw);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("JSON object");
  });

  test("rejects a bot whose model is blank, naming the bot", () => {
    const parsed = parseBotRegistry({ alpha: { model: "   ", systemPrompt: "You are." } });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('bot "alpha"');
  });

  test("rejects a bot with an unknown model, naming the bot", () => {
    const parsed = parseBotRegistry({
      alpha: { model: "gpt-9-imaginary", systemPrompt: "You are." },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('bot "alpha"');
    expect(parsed.error).toContain("gpt-9-imaginary");
  });

  test("rejects a delegate naming a missing bot, naming the bot", () => {
    const parsed = parseBotRegistry({
      alpha: { model: "deepseek-v4-pro", systemPrompt: "You are.", delegatesTo: ["ghost"] },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('bot "alpha"');
    expect(parsed.error).toContain("ghost");
  });
});

describe("resolveModelRef", () => {
  test("maps an @cf/ model to the cloudflare provider", () => {
    const model = "@cf/meta/llama-3.1-8b-instruct";
    expect(resolveModelRef(bot({ model }))).toEqual({ provider: "cloudflare", id: model });
  });

  test("maps a catalog id to opencode-go and passes the id through", () => {
    expect(resolveModelRef(bot({ model: "deepseek-v4-pro" }))).toEqual({
      provider: "opencode-go",
      id: "deepseek-v4-pro",
    });
  });
});

describe("decideWrite", () => {
  test("refuses to create over an existing id", async () => {
    const result = await decideWrite(roster({ alpha: bot() }), "alpha", bot(), "create");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("exists");
    expect(result.roster).toBeNull();
  });

  test("refuses to replace an unknown id", async () => {
    const result = await decideWrite(roster({ alpha: bot() }), "ghost", bot(), "replace");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("unknown");
    expect(result.roster).toBeNull();
  });

  test("creates a valid bot and returns the new roster", async () => {
    const created = bot({ model: "glm-5.3", thinkingLevel: "high" });
    const result = await decideWrite(roster({ alpha: bot() }), "beta", created, "create");
    expect(result.ok).toBe(true);
    expect(result.code).toBeNull();
    if (!result.ok) return;
    expect(result.roster.beta).toEqual(created);
    expect(result.roster.alpha).toBeDefined();
  });

  test("replaces a valid bot and returns the new roster", async () => {
    const replaced = bot({ model: "glm-5.3" });
    const result = await decideWrite(roster({ alpha: bot() }), "alpha", replaced, "replace");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roster.alpha).toEqual(replaced);
  });

  test("rejects an unknown model with the rule's message", async () => {
    const result = await decideWrite(
      roster({ alpha: bot() }),
      "beta",
      bot({ model: "gpt-9-imaginary" }),
      "create",
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid");
    expect(result.error).toContain("gpt-9-imaginary");
  });

  test("rejects an unsupported thinking level with the rule's message", async () => {
    const result = await decideWrite(
      roster({ alpha: bot() }),
      "beta",
      bot({ model: "deepseek-v4-pro", thinkingLevel: "medium" }),
      "create",
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid");
    expect(result.error).toContain("high, max");
  });

  test("rejects a delegate naming a missing bot with the rule's message", async () => {
    const result = await decideWrite(
      roster({ alpha: bot() }),
      "alpha",
      bot({ delegatesTo: ["ghost"] }),
      "replace",
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid");
    expect(result.error).toContain("ghost");
  });
});
