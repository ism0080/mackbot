import type { ActiveRunView, BotView } from "@mackbot/contract";
import type { Html, HtmlBuilder } from "foldkit/html";

import { Message } from "./message.ts";
import type { Model } from "./model.ts";
import { TOAST_ID, Toast } from "./toast.ts";

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
 * The transient answers, as the toast stack the shell appends inside its
 * `.screen`. The stack owns the container, the entries and their lifecycle; the
 * app supplies the words and the styling hooks, so an answer nobody reads
 * retires itself instead of waiting to be clicked away.
 */
export const toast = (model: Model, h: HtmlBuilder<Message>): readonly Html[] => [
  h.submodel({
    slotId: TOAST_ID,
    model: model.toast,
    view: Toast.view,
    viewInputs: {
      position: "BottomCenter",
      ariaLabel: "mackbot answers",
      containerClassName: "toaststack",
      entryClassName: "toast",
      entryToView: (entry, handlers) =>
        h.div(
          [h.Class("toast-inner")],
          [
            h.span(
              [h.DataAttribute("toast", ""), h.DataAttribute("variant", entry.variant)],
              [entry.payload.text],
            ),
            h.button([...handlers.dismiss, h.Class("toast-close")], ["Dismiss"]),
          ],
        ),
    },
    toParentMessage: (message) => Message.GotToastMessage({ message }),
  }),
];
