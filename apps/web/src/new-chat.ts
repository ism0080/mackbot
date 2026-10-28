/**
 * new-chat — the bot picker.
 *
 * The home shows work that already exists, so an idle bot has no row there and
 * no way into a conversation. This screen lists every bot the fleet reports,
 * and each row opens its transcript, where the composer can start new work.
 */
import type { BotView } from "@mackbot/contract";
import { Option } from "effect";
import { AsyncData } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { Message } from "./message.ts";
import type { Model } from "./model.ts";
import { avatar, botName, modelLabel, toast } from "./partials.ts";

const statusIn = (model: Model, bot: string): Option.Option<BotView> =>
  Option.match(Option.fromNullishOr(model.channels[bot]), {
    onNone: () => Option.none(),
    onSome: (channel) => AsyncData.getData(channel.status),
  });

const botRow = (model: Model, bot: string, h: HtmlBuilder<Message>): Html => {
  const status = statusIn(model, bot);
  const label = Option.match(status, {
    onNone: () => "no status yet",
    onSome: (view) => modelLabel(view),
  });

  return h.keyed("button")(
    bot,
    [
      h.Class("chatitem"),
      h.DataAttribute("bot", bot),
      h.AriaLabel(`Chat with ${botName(bot)}`),
      h.OnClick(Message.ClickedOpenTranscript({ bot })),
    ],
    [
      avatar(bot, h),
      h.span(
        [h.Class("runit-main")],
        [h.span([h.Class("rt")], [botName(bot)]), h.span([h.Class("rmeta")], [label])],
      ),
      h.span([h.Class("chev")], ["›"]),
    ],
  );
};

export const newChat = (model: Model, h: HtmlBuilder<Message>): Html => {
  const bots = Object.keys(model.channels).sort();

  const body: readonly Html[] =
    bots.length === 0
      ? [
          h.div(
            [h.Class("empty")],
            [
              h.strong([], ["No bots yet"]),
              h.p([], ["Add a bot to the roster, then start a chat with it from here."]),
              h.button(
                [
                  h.Class("btn ghost"),
                  h.DataAttribute("open", "bots"),
                  h.OnClick(Message.ClickedOpenBots()),
                ],
                ["Open Bots"],
              ),
            ],
          ),
        ]
      : [
          h.section(
            [h.Class("grp")],
            bots.map((bot) => botRow(model, bot, h)),
          ),
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
            [h.h1([], ["New chat"]), h.span([h.Class("hdr-sub")], [`${bots.length} bots`])],
          ),
        ],
      ),
      h.main([h.Class("scroll")], [...body, h.div([h.Class("pad")])]),
      ...toast(model.toast, h),
    ],
  );
};
