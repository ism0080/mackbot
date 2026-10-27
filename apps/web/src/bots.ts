/**
 * bots — the roster screen.
 *
 * Every bot the registry holds, one card each, with the fields a human edits:
 * the model, the thinking level, the prompt and the brief. The rest of a bot's
 * configuration — its delegate list, its run policy and its commitments flag —
 * is not editable here, so it is carried through the save untouched.
 *
 * Pure: the screen is a function of the Model, and the Model holds the edits.
 */
import type { BotConfig, ModelCatalog } from "@mackbot/contract";
import { ThinkingLevelSchema } from "@mackbot/contract";
import { Option } from "effect";
import * as Schema from "effect/Schema";
import { AsyncData } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { Message } from "./message.ts";
import type { Model, ThinkingLevel } from "./model.ts";
import { botName, toast } from "./partials.ts";

/** The value the level select carries when the bot declares no level. */
const NO_LEVEL = "";

const dataOf = <A, E>(data: AsyncData.AsyncData<A, E>): A | undefined =>
  Option.match(AsyncData.getData(data), {
    onNone: () => undefined,
    onSome: (value) => value,
  });

const errorOf = <A, E>(data: AsyncData.AsyncData<A, E>): E | undefined =>
  Option.match(AsyncData.getError(data), {
    onNone: () => undefined,
    onSome: (error) => error,
  });

/**
 * The models the picker offers: the catalog's, plus the bot's own model when
 * the catalog does not list it, so a Workers AI model stays visible.
 */
const modelOptions = (catalog: ModelCatalog, current: string): readonly string[] => {
  const known = Object.keys(catalog.models).sort();
  if (current.length === 0) return known;
  return known.includes(current) ? known : [...known, current];
};

/**
 * The levels the picker offers for a model: the ones the catalog says it
 * supports, and the level the bot already had when the catalog does not know
 * the model at all.
 */
const levelOptions = (
  catalog: ModelCatalog,
  model: string,
  current: ThinkingLevel | undefined,
): readonly ThinkingLevel[] => {
  const supported = catalog.models[model];
  if (supported !== undefined) return supported;
  return current === undefined ? [] : [current];
};

/** A level the select offered, or none when the value is not one. */
const levelOf = (value: string): ThinkingLevel | null =>
  Schema.is(ThinkingLevelSchema)(value) ? value : null;

const field = (label: string, control: Html, h: HtmlBuilder<Message>): Html =>
  h.label([h.Class("field")], [h.span([h.Class("field-label")], [label]), control]);

/**
 * The model picker. `bot` is null for the bot being created, which has no id
 * yet; a draft with no model yet says so rather than showing the first model
 * of the catalog as if it were chosen.
 */
const modelSelect = (
  bot: string | null,
  current: string,
  catalog: ModelCatalog,
  h: HtmlBuilder<Message>,
): Html =>
  h.select(
    [
      h.Class("input"),
      h.DataAttribute("field", "model"),
      h.Value(current),
      h.OnChange((value) => Message.EditedBotModel({ bot, model: value })),
    ],
    [
      ...(current.length === 0
        ? [h.option([h.Value(""), h.Selected(true)], ["Choose a model"])]
        : []),
      ...modelOptions(catalog, current).map((option) =>
        h.option([h.Value(option), h.Selected(option === current)], [option]),
      ),
    ],
  );

/**
 * The thinking level picker. The first option is the bot declaring no level,
 * which is not the same thing as the level named "none".
 */
const levelSelect = (
  bot: string | null,
  current: ThinkingLevel | null | undefined,
  model: string,
  catalog: ModelCatalog,
  h: HtmlBuilder<Message>,
): Html => {
  const chosen = current ?? undefined;
  return h.select(
    [
      h.Class("input"),
      h.DataAttribute("field", "level"),
      h.Value(chosen ?? NO_LEVEL),
      h.OnChange((value) =>
        Message.EditedBotLevel({ bot, level: value === NO_LEVEL ? null : levelOf(value) }),
      ),
    ],
    [
      h.option([h.Value(NO_LEVEL), h.Selected(chosen === undefined)], ["No level"]),
      ...levelOptions(catalog, model, chosen).map((level) =>
        h.option([h.Value(level), h.Selected(level === chosen)], [level]),
      ),
    ],
  );
};

const promptArea = (bot: string | null, current: string, h: HtmlBuilder<Message>): Html =>
  h.textarea([
    h.Class("input"),
    h.DataAttribute("field", "prompt"),
    h.Value(current),
    h.OnInput((value) => Message.EditedBotPrompt({ bot, prompt: value })),
  ]);

const briefArea = (bot: string | null, current: string, h: HtmlBuilder<Message>): Html =>
  h.textarea([
    h.Class("input"),
    h.DataAttribute("field", "brief"),
    h.Value(current),
    h.OnInput((value) => Message.EditedBotBrief({ bot, brief: value })),
  ]);

/** One bot of the roster, with the fields a human edits. */
const botCard = (
  bot: string,
  config: BotConfig,
  catalog: ModelCatalog,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed("div")(
    bot,
    [h.Class("botcard"), h.DataAttribute("bot", bot)],
    [
      h.div(
        [h.Class("botcard-head")],
        [
          h.span([h.Class("botcard-id")], [botName(bot)]),
          h.span([h.Class("botcard-model")], [config.model]),
        ],
      ),
      field("Model", modelSelect(bot, config.model, catalog, h), h),
      field("Thinking level", levelSelect(bot, config.thinkingLevel, config.model, catalog, h), h),
      field("System prompt", promptArea(bot, config.systemPrompt, h), h),
      field("Brief", briefArea(bot, config.brief ?? "", h), h),
      h.div(
        [h.Class("botcard-actions")],
        [
          h.button(
            [
              h.Class("btn primary"),
              h.DataAttribute("save", bot),
              h.OnClick(Message.ClickedSaveBot({ bot })),
            ],
            ["Save"],
          ),
        ],
      ),
    ],
  );

/** The form that adds a bot. */
const createCard = (model: Model, catalog: ModelCatalog, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("botcard new"), h.DataAttribute("new", "")],
    [
      h.div([h.Class("botcard-head")], [h.span([h.Class("botcard-id")], ["New bot"])]),
      field(
        "Id",
        h.input([
          h.Class("input"),
          h.Type("text"),
          h.DataAttribute("field", "id"),
          h.Value(model.newBotId),
          h.Placeholder("atlas"),
          h.OnInput((value) => Message.EditedNewBotId({ id: value })),
        ]),
        h,
      ),
      field("Model", modelSelect(null, model.draft.model, catalog, h), h),
      field(
        "Thinking level",
        levelSelect(null, model.draft.thinkingLevel, model.draft.model, catalog, h),
        h,
      ),
      field("System prompt", promptArea(null, model.draft.systemPrompt, h), h),
      field("Brief", briefArea(null, model.draft.brief, h), h),
      h.div(
        [h.Class("botcard-actions")],
        [
          h.button(
            [
              h.Class("btn primary"),
              h.DataAttribute("create", ""),
              h.OnClick(Message.ClickedCreateBot()),
            ],
            ["Add bot"],
          ),
        ],
      ),
    ],
  );

/** Why the roster is not on the screen: it has not arrived, or it could not
 *  be read. */
const notice = (model: Model, h: HtmlBuilder<Message>): Html => {
  const error = errorOf(model.registry);
  return h.div(
    [h.Class("empty")],
    [
      h.p(
        [],
        [error === undefined ? "Reading the roster…" : `Couldn't read the roster (${error}).`],
      ),
    ],
  );
};

export const bots = (model: Model, h: HtmlBuilder<Message>): Html => {
  const roster = dataOf(model.registry);
  const catalog = dataOf(model.catalog) ?? { models: {} };
  const cards = roster === undefined ? [] : Object.entries(roster.bots);

  const body: readonly Html[] = [
    ...(roster === undefined
      ? [notice(model, h)]
      : [
          h.section(
            [h.Class("grp")],
            [
              h.h2([], ["Roster"]),
              ...(cards.length === 0
                ? [h.div([h.Class("empty")], [h.p([], ["No bots yet."])])]
                : cards.map(([bot, config]) => botCard(bot, config, catalog, h))),
            ],
          ),
        ]),
    h.section([h.Class("grp")], [h.h2([], ["Add a bot"]), createCard(model, catalog, h)]),
    h.div([h.Class("pad")]),
  ];

  return h.div(
    [h.Class("screen")],
    [
      h.header(
        [h.Class("hdr")],
        [
          h.button(
            [h.Class("icon"), h.AriaLabel("Back to Needs you"), h.OnClick(Message.ClickedBack())],
            ["‹"],
          ),
          h.span(
            [h.Class("hdr-main stacked")],
            [h.h1([], ["Bots"]), h.span([h.Class("hdr-sub")], [`${cards.length} bots`])],
          ),
        ],
      ),
      h.main([h.Class("scroll")], body),
      ...toast(model.toast, h),
    ],
  );
};
