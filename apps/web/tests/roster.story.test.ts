import type { BotConfig } from "@mackbot/contract";
import { AsyncData } from "foldkit";
import { Command, given, message, model, story } from "foldkit/story";
import { describe, expect, test } from "vitest";

import { CreateBot, SaveBot } from "../src/api.ts";
import { Message } from "../src/message.ts";
import { EMPTY_DRAFT } from "../src/model.ts";
import type { Model } from "../src/model.ts";
import { update } from "../src/update.ts";
import { CATALOG, botConfigOf, modelWith, rosterOf } from "./support/fixtures.ts";
import { dataOf, errorOf } from "./support/story.ts";
import { settleToast, toastText } from "./support/toast.ts";

const hermesConfig = (overrides: Partial<BotConfig> = {}) =>
  botConfigOf({
    model: "deepseek-v4-pro",
    thinkingLevel: "high",
    systemPrompt: "You are Hermes, my chief of staff.",
    brief: "Hourly check-in.",
    delegatesTo: ["scribe"],
    runtime: { maxRetries: 3, parallelTools: true },
    commitments: true,
    ...overrides,
  });

/** The roster screen's starting point: the server's roster and the catalog. */
const seeded = () => ({
  ...modelWith(),
  registry: AsyncData.succeed(rosterOf({ hermes: hermesConfig() })),
  catalog: AsyncData.succeed(CATALOG),
});

const registryIn = (m: Model) => dataOf(m.registry).bots;

describe("EditedBotModel", () => {
  test("keeps a level the new catalog model also supports", () => {
    story(
      update,
      given(seeded()),
      message(Message.EditedBotModel({ bot: "hermes", model: "claude-haiku-5-5" })),
      Command.expectNone(),
      model((m) => {
        const bots = registryIn(m);
        expect(bots.hermes?.model).toBe("claude-haiku-5-5");
        expect(bots.hermes?.thinkingLevel).toBe("high");
        // The other bot is not part of this edit.
        expect(bots.scribe?.model).toBe("longcat-2.5-preview-free");
      }),
    );
  });

  test("clears a level the new catalog model does not support", () => {
    const seededHaiku = {
      ...seeded(),
      registry: AsyncData.succeed(
        rosterOf({ hermes: hermesConfig({ model: "claude-haiku-5-5" }) }),
      ),
    };

    story(
      update,
      given(seededHaiku),
      message(Message.EditedBotModel({ bot: "hermes", model: "longcat-2.5-preview-free" })),
      Command.expectNone(),
      model((m) => {
        const bots = registryIn(m);
        expect(bots.hermes?.model).toBe("longcat-2.5-preview-free");
        expect(bots.hermes?.thinkingLevel).toBeUndefined();
      }),
    );
  });

  test("leaves a Workers AI model's level alone because the catalog does not list it", () => {
    story(
      update,
      given(seeded()),
      message(Message.EditedBotModel({ bot: "hermes", model: "@cf/meta/llama-3-8b-instruct" })),
      Command.expectNone(),
      model((m) => {
        const bots = registryIn(m);
        expect(bots.hermes?.model).toBe("@cf/meta/llama-3-8b-instruct");
        expect(bots.hermes?.thinkingLevel).toBe("high");
      }),
    );
  });
});

describe("editing one field", () => {
  test("EditedBotLevel changes only that bot and keeps hidden fields", () => {
    story(
      update,
      given(seeded()),
      message(Message.EditedBotLevel({ bot: "hermes", level: "max" })),
      Command.expectNone(),
      model((m) => {
        const bots = registryIn(m);
        expect(bots.hermes?.thinkingLevel).toBe("max");
        expect(bots.hermes?.delegatesTo).toEqual(["scribe"]);
        expect(bots.hermes?.runtime).toEqual({ maxRetries: 3, parallelTools: true });
        expect(bots.hermes?.commitments).toBe(true);
        expect(bots.scribe?.thinkingLevel).toBeUndefined();
      }),
    );
  });

  test("EditedBotPrompt changes only the prompt", () => {
    story(
      update,
      given(seeded()),
      message(Message.EditedBotPrompt({ bot: "hermes", prompt: "You are Hermes, rewritten." })),
      Command.expectNone(),
      model((m) => {
        const bots = registryIn(m);
        expect(bots.hermes?.systemPrompt).toBe("You are Hermes, rewritten.");
        expect(bots.hermes?.model).toBe("deepseek-v4-pro");
        expect(bots.hermes?.brief).toBe("Hourly check-in.");
        expect(bots.scribe?.systemPrompt).toBe("You are Scribe, my note-taker.");
      }),
    );
  });

  test("EditedBotBrief turns an empty brief into no brief", () => {
    story(
      update,
      given(seeded()),
      message(Message.EditedBotBrief({ bot: "hermes", brief: "" })),
      Command.expectNone(),
      model((m) => {
        const bots = registryIn(m);
        expect(bots.hermes?.brief).toBeUndefined();
        expect(bots.hermes?.delegatesTo).toEqual(["scribe"]);
        expect(bots.scribe).toBeDefined();
      }),
    );
  });
});

describe("saving a bot", () => {
  test("refuses an empty model with a toast and no Command", () => {
    const seededEmpty = {
      ...seeded(),
      registry: AsyncData.succeed({ bots: { hermes: { model: "", systemPrompt: "still here" } } }),
    };

    story(
      update,
      given(seededEmpty),
      message(Message.ClickedSaveBot({ bot: "hermes" })),
      settleToast(),
      model((m) => {
        expect(toastText(m)).toBe("Couldn't save Hermes: the model is empty.");
      }),
    );
  });

  test("refuses an empty system prompt with a toast and no Command", () => {
    const seededEmpty = {
      ...seeded(),
      registry: AsyncData.succeed({
        bots: { hermes: { model: "deepseek-v4-pro", systemPrompt: "   " } },
      }),
    };

    story(
      update,
      given(seededEmpty),
      message(Message.ClickedSaveBot({ bot: "hermes" })),
      settleToast(),
      model((m) => {
        expect(toastText(m)).toBe("Couldn't save Hermes: the system prompt is empty.");
      }),
    );
  });

  test("emits SaveBot with the bot's whole configuration", () => {
    story(
      update,
      given(seeded()),
      message(Message.ClickedSaveBot({ bot: "hermes" })),
      Command.expectExact(SaveBot({ bot: "hermes", config: hermesConfig() })),
      Command.resolve(
        SaveBot({ bot: "hermes", config: hermesConfig() }),
        Message.BotSaved({ id: "hermes", bot: hermesConfig() }),
      ),
      settleToast(),
      model((m) => {
        expect(toastText(m)).toBe("Saved Hermes.");
      }),
    );
  });

  test("BotSaved replaces the working copy with the server's answer", () => {
    const stored = hermesConfig({
      systemPrompt: "The server's own words.",
      brief: "Stored brief.",
    });

    story(
      update,
      given(seeded()),
      message(Message.BotSaved({ id: "hermes", bot: stored })),
      settleToast(),
      model((m) => {
        const bots = registryIn(m);
        expect(bots.hermes).toEqual(stored);
        expect(bots.scribe).toBeDefined();
        expect(toastText(m)).toBe("Saved Hermes.");
      }),
    );
  });
});

describe("creating a bot", () => {
  const draft = (overrides: Partial<Model["draft"]> = {}) => ({
    model: "deepseek-v4-pro",
    thinkingLevel: "high" as const,
    systemPrompt: "You are New, a helper.",
    brief: "",
    ...overrides,
  });

  test("refuses a blank id", () => {
    story(
      update,
      given({ ...seeded(), newBotId: "   ", draft: draft() }),
      message(Message.ClickedCreateBot()),
      settleToast(),
      model((m) => {
        expect(toastText(m)).toBe("The new bot needs an id.");
      }),
    );
  });

  test("refuses an id that is not a slug", () => {
    story(
      update,
      given({ ...seeded(), newBotId: "Not A Slug", draft: draft() }),
      message(Message.ClickedCreateBot()),
      settleToast(),
      model((m) => {
        expect(toastText(m)).toBe("The id has to be a slug: lowercase letters, digits and dashes.");
      }),
    );
  });

  test("refuses a draft with no model", () => {
    story(
      update,
      given({ ...seeded(), newBotId: "newbie", draft: draft({ model: "" }) }),
      message(Message.ClickedCreateBot()),
      settleToast(),
      model((m) => {
        expect(toastText(m)).toBe("The new bot needs a model.");
      }),
    );
  });

  test("refuses a draft with no system prompt", () => {
    story(
      update,
      given({ ...seeded(), newBotId: "newbie", draft: draft({ systemPrompt: "  " }) }),
      message(Message.ClickedCreateBot()),
      settleToast(),
      model((m) => {
        expect(toastText(m)).toBe("The new bot needs a system prompt.");
      }),
    );
  });

  test("emits CreateBot with a trimmed id and no blank brief", () => {
    story(
      update,
      given({ ...seeded(), newBotId: "  newbie  ", draft: draft({ brief: "   " }) }),
      message(Message.ClickedCreateBot()),
      Command.expectExact(
        CreateBot({
          id: "newbie",
          bot: {
            model: "deepseek-v4-pro",
            systemPrompt: "You are New, a helper.",
            thinkingLevel: "high",
            brief: undefined,
          },
        }),
      ),
      Command.resolve(
        CreateBot({
          id: "newbie",
          bot: {
            model: "deepseek-v4-pro",
            systemPrompt: "You are New, a helper.",
            thinkingLevel: "high",
            brief: undefined,
          },
        }),
        Message.BotCreated({
          id: "newbie",
          bot: botConfigOf({
            model: "deepseek-v4-pro",
            thinkingLevel: "high",
            systemPrompt: "You are New, a helper.",
          }),
        }),
      ),
      settleToast(),
    );
  });

  test("BotCreated adds the bot, resets the draft and toasts", () => {
    const created = botConfigOf({
      model: "longcat-2.5-preview-free",
      systemPrompt: "You are New, a helper.",
    });

    story(
      update,
      given({ ...seeded(), newBotId: "newbie", draft: draft() }),
      message(Message.BotCreated({ id: "newbie", bot: created })),
      settleToast(),
      model((m) => {
        const bots = registryIn(m);
        expect(bots.newbie).toEqual(created);
        expect(bots.hermes).toBeDefined();
        expect(m.draft).toEqual(EMPTY_DRAFT);
        expect(m.newBotId).toBe("");
        expect(toastText(m)).toBe("Added Newbie.");
      }),
    );
  });
});

describe("the roster fetch", () => {
  test("RosterLoaded seeds the working copy", () => {
    const roster = rosterOf();

    story(
      update,
      given(modelWith()),
      message(Message.RosterLoaded({ roster })),
      Command.expectNone(),
      model((m) => {
        expect(dataOf(m.registry)).toEqual(roster);
        expect(dataOf(m.registry).bots.hermes?.brief).toBe("Hourly check-in.");
      }),
    );
  });

  test("RosterFailed surfaces the error", () => {
    story(
      update,
      given(modelWith()),
      message(Message.RosterFailed({ error: "the registry did not answer" })),
      Command.expectNone(),
      model((m) => {
        expect(errorOf(m.registry)).toBe("the registry did not answer");
      }),
    );
  });
});
