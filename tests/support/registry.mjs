/**
 * A fake `Registry` binding, for the tests that drive the front door.
 *
 * The registry is the truth about which bots exist, so a front-door test has
 * to offer one: the routes ask the registry whether a bot is there. The fake
 * answers the roster it is given and decides a write with the real rules, so
 * the refusals the routes answer are the refusals the Durable Object would
 * answer.
 */
import { decideWrite } from "../../src/registry-store.ts";

/** The bots the fake registry declares. */
export const DECLARED_BOTS = {
  hermes: {
    model: "deepseek-v4-pro",
    thinkingLevel: "high",
    systemPrompt: "You are Hermes.",
  },
};

/** The binding the front door reaches the registry through. */
export const registryBinding = (bots = DECLARED_BOTS) => {
  const roster = { ...bots };
  return {
    getByName: () => ({
      roster: async () => ({ ...roster }),
      bot: async (id) => roster[id],
      put: async (id, bot, mode) => {
        const decision = await decideWrite(roster, id, bot, mode);
        if (decision.ok) roster[id] = bot;
        return decision;
      },
    }),
  };
};
