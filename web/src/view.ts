import type { Document, HtmlBuilder } from "foldkit/html";

import { home } from "./home.ts";
import type { Message } from "./message.ts";
import { Screen } from "./model.ts";
import type { Model } from "./model.ts";
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
  });
