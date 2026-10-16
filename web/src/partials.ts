import type { BotView } from "@mackbot/web-contract";
import type { HtmlBuilder } from "foldkit/html";

import type { Message } from "./message.ts";

export const botName = (bot: string): string =>
  bot.length === 0 ? bot : bot.charAt(0).toUpperCase() + bot.slice(1);

export const botInitial = (bot: string): string => bot.slice(0, 1).toUpperCase();

export const avatar = (bot: string, h: HtmlBuilder<Message>) =>
  h.span([h.Class("av sm")], [botInitial(bot)]);

export const modelLabel = (bot: BotView): string =>
  bot.thinkingLevel === null ? bot.model.id : `${bot.model.id} · ${bot.thinkingLevel}`;

export const statusTag = (bot: BotView, h: HtmlBuilder<Message>) =>
  bot.busy ? h.span([h.Class("tag work")], ["working"]) : h.span([h.Class("tag")], ["idle"]);
