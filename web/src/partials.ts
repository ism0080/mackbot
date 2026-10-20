import type { ActiveRunView, BotView } from "@mackbot/contract";
import type { Html, HtmlBuilder } from "foldkit/html";

import { Message } from "./message.ts";
import type { Toast } from "./model.ts";

export const botName = (bot: string): string =>
  bot.length === 0 ? bot : bot.charAt(0).toUpperCase() + bot.slice(1);

export const botInitial = (bot: string): string => bot.slice(0, 1).toUpperCase();

export const avatar = (bot: string, h: HtmlBuilder<Message>) =>
  h.span([h.Class("av sm")], [botInitial(bot)]);

export const runTitle = (run: ActiveRunView): string => run.inputs[0] ?? "Working";

export const modelLabel = (bot: BotView): string =>
  bot.thinkingLevel === null ? bot.model.id : `${bot.model.id} · ${bot.thinkingLevel}`;

export const statusTag = (bot: BotView, h: HtmlBuilder<Message>) =>
  bot.busy ? h.span([h.Class("tag work")], ["working"]) : h.span([h.Class("tag")], ["idle"]);

/**
 * The transient server answer, as an element both screens append inside their
 * `.screen` shell. A button, because dismissing it is the only action it has.
 */
export const toast = (line: Toast | null, h: HtmlBuilder<Message>): readonly Html[] =>
  line === null
    ? []
    : [
        h.button(
          [
            h.Class("toast"),
            h.DataAttribute("toast", ""),
            h.AriaLive("polite"),
            h.OnClick(Message.DismissedToast()),
          ],
          [line.text],
        ),
      ];
