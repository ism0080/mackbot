import type { Document, HtmlBuilder } from "foldkit/html";

import { bots } from "./bots.ts";
import { home } from "./home.ts";
import type { Message } from "./message.ts";
import { Screen } from "./model.ts";
import type { Model } from "./model.ts";
import { newChat } from "./new-chat.ts";
import { botName } from "./partials.ts";
import { homeTitle } from "./select.ts";
import { transcript } from "./transcript.ts";

export const view = (model: Model, h: HtmlBuilder<Message>): Document =>
  Screen.match<Document>(model.screen, {
    Home: () => ({ title: homeTitle(model), lang: "en", body: home(model, h) }),
    Transcript: ({ bot }) => ({
      title: `${botName(bot)} · mackbot`,
      lang: "en",
      body: transcript(bot, model, h),
    }),
    NewChat: () => ({ title: "New chat · mackbot", lang: "en", body: newChat(model, h) }),
    Bots: () => ({ title: "Bots · mackbot", lang: "en", body: bots(model, h) }),
  });
