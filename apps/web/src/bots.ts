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
import * as Schema from "effect/Schema";
import type { Html, HtmlBuilder } from "foldkit/html";

import { dataOf, errorOf } from "./data.ts";
import { Message } from "./message.ts";
import type { Model, ThinkingLevel } from "./model.ts";
import { botName, toast } from "./partials.ts";
import { button, selectField, textareaField, textField } from "./ui.ts";

/** The value the level select carries when the bot declares no level. */
const NO_LEVEL = "";

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

/** A control's DOM id. The bot being created has no id yet, so it shares the
 *  `new` prefix every create-form control carries. */
const fieldId = (bot: string | null, name: string): string => `bot-${bot ?? "new"}-${name}`;

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
  selectField(
    {
      id: fieldId(bot, "model"),
      label: "Model",
      hook: "model",
      value: current,
      choices: [
        ...(current.length === 0 ? [{ value: "", label: "Choose a model" }] : []),
        ...modelOptions(catalog, current).map((model) => ({ value: model, label: model })),
      ],
      onChange: (value) => Message.EditedBotModel({ bot, model: value }),
    },
    h,
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
  return selectField(
    {
      id: fieldId(bot, "level"),
      label: "Thinking level",
      hook: "level",
      value: chosen ?? NO_LEVEL,
      choices: [
        { value: NO_LEVEL, label: "No level" },
        ...levelOptions(catalog, model, chosen).map((level) => ({ value: level, label: level })),
      ],
      onChange: (value) =>
        Message.EditedBotLevel({ bot, level: value === NO_LEVEL ? null : levelOf(value) }),
    },
    h,
  );
};

const promptArea = (bot: string | null, current: string, h: HtmlBuilder<Message>): Html =>
  textareaField(
    {
      id: fieldId(bot, "prompt"),
      label: "System prompt",
      hook: "prompt",
      value: current,
      onInput: (prompt) => Message.EditedBotPrompt({ bot, prompt }),
    },
    h,
  );

const briefArea = (bot: string | null, current: string, h: HtmlBuilder<Message>): Html =>
  textareaField(
    {
      id: fieldId(bot, "brief"),
      label: "Brief",
      hook: "brief",
      value: current,
      onInput: (brief) => Message.EditedBotBrief({ bot, brief }),
    },
    h,
  );

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
      modelSelect(bot, config.model, catalog, h),
      levelSelect(bot, config.thinkingLevel, config.model, catalog, h),
      promptArea(bot, config.systemPrompt, h),
      briefArea(bot, config.brief ?? "", h),
      h.div(
        [h.Class("botcard-actions")],
        [
          button(
            {
              className: "btn primary",
              data: [["save", bot]],
              onClick: Message.ClickedSaveBot({ bot }),
            },
            ["Save"],
            h,
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
      textField(
        {
          id: fieldId(null, "id"),
          label: "Id",
          hook: "id",
          value: model.newBotId,
          placeholder: "atlas",
          onInput: (id) => Message.EditedNewBotId({ id }),
        },
        h,
      ),
      modelSelect(null, model.draft.model, catalog, h),
      levelSelect(null, model.draft.thinkingLevel, model.draft.model, catalog, h),
      promptArea(null, model.draft.systemPrompt, h),
      briefArea(null, model.draft.brief, h),
      h.div(
        [h.Class("botcard-actions")],
        [
          button(
            {
              className: "btn primary",
              data: [["create", ""]],
              onClick: Message.ClickedCreateBot(),
            },
            ["Add bot"],
            h,
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
          button(
            { className: "icon", ariaLabel: "Back to Needs you", onClick: Message.ClickedBack() },
            ["‹"],
            h,
          ),
          h.span(
            [h.Class("hdr-main stacked")],
            [h.h1([], ["Bots"]), h.span([h.Class("hdr-sub")], [`${cards.length} bots`])],
          ),
        ],
      ),
      h.main([h.Class("scroll")], body),
      ...toast(model, h),
    ],
  );
};
