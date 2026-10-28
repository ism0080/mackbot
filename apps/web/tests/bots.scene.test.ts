/**
 * Scene tests for the roster screen.
 *
 * The screen edits the server's roster through a working copy, so the tests
 * care about two things: what the form shows, and what the save and create
 * Commands carry — including the fields the form never renders.
 */
import { AsyncData } from "foldkit";
import {
  all,
  Command,
  change,
  click,
  expect,
  expectAll,
  given,
  role,
  scene,
  selector,
  type,
  within,
} from "foldkit/scene";
import { test } from "vitest";

import { CreateBot, SaveBot } from "../src/api.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { update } from "../src/update.ts";
import { view } from "../src/view.ts";
import { botConfigOf, CATALOG, rosterOf } from "./support/fixtures.ts";
import { appModel } from "./support/scene.ts";
import { settleToastScene } from "./support/toast.ts";

const botsScreen = (roster = rosterOf()) =>
  appModel(
    Screen.Bots(),
    {},
    {
      registry: AsyncData.succeed(roster),
      catalog: AsyncData.succeed(CATALOG),
    },
  );

const card = (bot: string) => selector(`[data-bot="${bot}"]`);
const fieldIn = (bot: string, field: string) =>
  within(card(bot), selector(`[data-field="${field}"]`));
const newField = (field: string) => selector(`[data-new] [data-field="${field}"]`);

/** The whole Hermes configuration, with the two fields the form edits. */
const hermesConfig = (overrides: { systemPrompt?: string; brief?: string } = {}) => ({
  model: "deepseek-v4-pro",
  systemPrompt: overrides.systemPrompt ?? "You are Hermes, my chief of staff.",
  brief: overrides.brief ?? "Hourly check-in.",
  delegatesTo: ["scribe"],
  runtime: { maxRetries: 3, parallelTools: true },
  commitments: true,
});

test("the roster shows one card per bot with its model, prompt and brief", () => {
  scene(
    { update, view },
    given(botsScreen()),
    expect(role("heading", { name: "Bots", level: 1 })).toExist(),
    expect(card("hermes")).toExist(),
    expect(card("scribe")).toExist(),
    expectAll(all.selector("[data-bot]")).toHaveCount(2),
    expect(card("hermes")).toContainText("deepseek-v4-pro"),
    expect(fieldIn("hermes", "model")).toHaveValue("deepseek-v4-pro"),
    expect(fieldIn("hermes", "prompt")).toHaveValue("You are Hermes, my chief of staff."),
    expect(fieldIn("hermes", "brief")).toHaveValue("Hourly check-in."),
    expect(fieldIn("scribe", "model")).toHaveValue("longcat-2.5-preview-free"),
  );
});

test("the fields the form does not show are not editable here", () => {
  scene(
    { update, view },
    given(botsScreen()),
    // The delegate list, run policy and commitments flag are carried through a
    // save, never rendered as controls of their own.
    expect(card("hermes")).not.toContainText("scribe"),
    expect(card("hermes")).not.toContainText("maxRetries"),
    expect(card("hermes")).not.toContainText("parallelTools"),
    expectAll(all.selector('[data-bot="hermes"] input')).toBeEmpty(),
  );
});

test("changing to a model without the level clears the level", () => {
  scene(
    { update, view },
    given(
      botsScreen(
        rosterOf({
          hermes: botConfigOf({
            model: "deepseek-v4-pro",
            thinkingLevel: "high",
            systemPrompt: "You are Hermes.",
          }),
        }),
      ),
    ),
    expect(fieldIn("hermes", "level")).toHaveValue("high"),
    change(fieldIn("hermes", "model"), "longcat-2.5-preview-free"),
    expect(fieldIn("hermes", "model")).toHaveValue("longcat-2.5-preview-free"),
    // That model declares no levels, so "high" is not a level it can keep.
    expect(fieldIn("hermes", "level")).toHaveValue(""),
  );
});

test("changing to a model that supports the level keeps it", () => {
  scene(
    { update, view },
    given(
      botsScreen(
        rosterOf({
          hermes: botConfigOf({
            model: "deepseek-v4-pro",
            thinkingLevel: "high",
            systemPrompt: "You are Hermes.",
          }),
        }),
      ),
    ),
    change(fieldIn("hermes", "model"), "claude-haiku-5-5"),
    expect(fieldIn("hermes", "level")).toHaveValue("high"),
  );
});

test("Save sends the whole configuration, including the hidden fields", () => {
  const saved = hermesConfig({
    systemPrompt: "You are Hermes, updated.",
    brief: "Nightly digest.",
  });

  scene(
    { update, view },
    given(botsScreen()),
    type(fieldIn("hermes", "prompt"), saved.systemPrompt),
    type(fieldIn("hermes", "brief"), saved.brief),
    click(selector('[data-save="hermes"]')),
    Command.expectExact(SaveBot({ bot: "hermes", config: saved })),
    Command.resolve(SaveBot, Message.BotSaved({ id: "hermes", bot: saved })),
    settleToastScene(),
    expect(selector("[data-toast]")).toHaveText("Saved Hermes."),
    expect(fieldIn("hermes", "prompt")).toHaveValue(saved.systemPrompt),
    expect(fieldIn("hermes", "brief")).toHaveValue(saved.brief),
  );
});

test("a save with no model is refused before it reaches the server", () => {
  scene(
    { update, view },
    given(botsScreen()),
    change(fieldIn("hermes", "model"), ""),
    click(selector('[data-save="hermes"]')),
    expect(selector("[data-toast]")).toHaveText("Couldn't save Hermes: the model is empty."),
    settleToastScene(),
  );
});

test("Add bot sends the trimmed id and the draft's fields, then clears the draft", () => {
  const created = {
    model: "claude-haiku-5-5",
    systemPrompt: "You are Atlas.",
    thinkingLevel: undefined,
    brief: "Weekly digest.",
  };

  scene(
    { update, view },
    given(botsScreen()),
    type(newField("id"), "  atlas  "),
    change(newField("model"), created.model),
    type(newField("prompt"), created.systemPrompt),
    type(newField("brief"), created.brief),
    click(selector("[data-create]")),
    Command.expectExact(CreateBot({ id: "atlas", bot: created })),
    Command.resolve(CreateBot, Message.BotCreated({ id: "atlas", bot: created })),
    settleToastScene(),
    expect(selector('[data-bot="atlas"]')).toExist(),
    expect(selector("[data-toast]")).toHaveText("Added Atlas."),
    expect(newField("id")).toHaveValue(""),
    expect(newField("model")).toHaveValue(""),
    expect(newField("prompt")).toHaveValue(""),
    expect(newField("brief")).toHaveValue(""),
  );
});

test("Add bot with no brief leaves the brief off the wire", () => {
  scene(
    { update, view },
    given(botsScreen()),
    type(newField("id"), "atlas"),
    change(newField("model"), "deepseek-v4-pro"),
    type(newField("prompt"), "You are Atlas."),
    click(selector("[data-create]")),
    Command.expectExact(
      CreateBot({
        id: "atlas",
        bot: {
          model: "deepseek-v4-pro",
          systemPrompt: "You are Atlas.",
          thinkingLevel: undefined,
          brief: undefined,
        },
      }),
    ),
    Command.resolve(
      CreateBot,
      Message.BotCreated({
        id: "atlas",
        bot: {
          model: "deepseek-v4-pro",
          systemPrompt: "You are Atlas.",
        },
      }),
    ),
    settleToastScene(),
    expect(selector('[data-bot="atlas"]')).toExist(),
  );
});

test("Add bot refuses an id that is not a slug", () => {
  scene(
    { update, view },
    given(botsScreen()),
    type(newField("id"), "Atlas Bot"),
    change(newField("model"), "deepseek-v4-pro"),
    type(newField("prompt"), "You are Atlas."),
    click(selector("[data-create]")),
    expect(selector("[data-toast]")).toHaveText(
      "The id has to be a slug: lowercase letters, digits and dashes.",
    ),
    settleToastScene(),
  );
});

test("a Workers AI model the catalog does not know stays in the picker", () => {
  const edge = "@cf/meta/llama-3-8b-instruct";

  scene(
    { update, view },
    given(
      botsScreen(
        rosterOf({
          edge: botConfigOf({ model: edge, systemPrompt: "You are Edge." }),
        }),
      ),
    ),
    expect(fieldIn("edge", "model")).toHaveValue(edge),
    expect(within(card("edge"), selector(`option[value="${edge}"]`))).toExist(),
  );
});

test("the roster says it is still loading", () => {
  scene(
    { update, view },
    given(appModel(Screen.Bots(), {}, { registry: AsyncData.Idle() })),
    expect(selector(".empty p")).toHaveText("Reading the roster…"),
    expect(selector("[data-new]")).toExist(),
  );
});

test("a roster that could not be read says why", () => {
  scene(
    { update, view },
    given(appModel(Screen.Bots(), {}, { registry: AsyncData.fail("gateway timeout") })),
    expect(selector(".empty p")).toHaveText("Couldn't read the roster (gateway timeout)."),
  );
});
