/**
 * roster-fold — the roster screen's edits.
 *
 * The roster is the working copy of the fleet's configuration, and the create
 * form is the draft of a bot that has no id yet. One edit lands in exactly one
 * of them, so every field's handler goes through `editBotOrDraft` rather than
 * spelling out both halves.
 */
import type { BotConfig, ModelCatalog } from "@mackbot/contract";
import { AsyncData } from "foldkit";
import { modifyFields } from "foldkit/struct";

import { dataOf } from "./data.ts";
import type { BotDraft, Model, ThinkingLevel } from "./model.ts";

/** The roster's bots, or none at all when the roster is not in hand. */
export const botsOf = (model: Model): Record<string, BotConfig> =>
  dataOf(model.registry)?.bots ?? {};

/**
 * The roster with its bots replaced. The state of the fetch is kept, so a
 * roster that failed to refresh keeps saying so while the edits land.
 */
export const withBots = (model: Model, bots: Record<string, BotConfig>): Model =>
  modifyFields(model, {
    registry: (registry) => AsyncData.map(registry, (roster) => ({ ...roster, bots })),
  });

/**
 * One bot's configuration, changed. The roster is the working copy, so the
 * edit lands in the roster's own entry and everything the form does not show
 * stays where it was.
 */
const editBot = (model: Model, bot: string, change: (config: BotConfig) => BotConfig): Model => {
  const roster = dataOf(model.registry);
  const config = roster?.bots[bot];
  if (roster === undefined || config === undefined) return model;
  return withBots(model, { ...roster.bots, [bot]: change(config) });
};

/**
 * One field edited. `bot` names the bot whose configuration changed, and is
 * `null` for the bot being created, which only has the draft.
 */
export const editBotOrDraft = (
  model: Model,
  bot: string | null,
  changes: {
    readonly draft: (draft: BotDraft) => BotDraft;
    readonly config: (config: BotConfig) => BotConfig;
  },
): Model =>
  bot === null
    ? modifyFields(model, { draft: changes.draft })
    : editBot(model, bot, changes.config);

/** The catalog the pickers read, or an empty one when it has not arrived. */
export const catalogOf = (model: Model): ModelCatalog => dataOf(model.catalog) ?? { models: {} };

/**
 * The level a bot may keep when its model changes. The catalog says which
 * levels a model supports, so a level the new model does not have goes back
 * to none — the rule the server holds as well.
 *
 * A model the catalog does not list — a Workers AI model — supports every
 * level, so nothing is taken away from it.
 */
export const levelFor = (
  catalog: ModelCatalog,
  model: string,
  level: ThinkingLevel | undefined,
): ThinkingLevel | undefined => {
  if (level === undefined) return undefined;
  const supported = catalog.models[model];
  if (supported === undefined) return level;
  return supported.includes(level) ? level : undefined;
};

/** The field a configuration is missing, if any. The server refuses both, so
 *  the form refuses them before the round trip. */
export const emptyFieldOf = (config: BotConfig): string | null =>
  config.model.trim().length === 0
    ? "model"
    : config.systemPrompt.trim().length === 0
      ? "system prompt"
      : null;

/** The draft of the bot being created, as the configuration the wire takes. */
export const configOfDraft = (draft: BotDraft): BotConfig => ({
  model: draft.model,
  systemPrompt: draft.systemPrompt,
  thinkingLevel: draft.thinkingLevel,
  brief: draft.brief.trim().length === 0 ? undefined : draft.brief,
});
