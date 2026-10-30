/**
 * archive — the conversations a person archived with one bot.
 *
 * Archiving takes a conversation out of the bot's list without deleting it, so
 * this screen is the way back: each archived conversation is listed with when
 * it was last active, and Restore puts it back in the list.
 */
import type { ThreadView } from "@mackbot/contract";
import type { Html, HtmlBuilder } from "foldkit/html";

import { archivedThreadsOf } from "./channel.ts";
import { dataOf, errorOf } from "./data.ts";
import { elapsedOf } from "./format.ts";
import { Message } from "./message.ts";
import type { Channel, Model } from "./model.ts";
import { avatar, botName, toast } from "./partials.ts";
import { button } from "./ui.ts";

/** What an archived conversation is called: its title, or that it has none. */
const archivedLabel = (view: ThreadView): string => view.title ?? "Untitled conversation";

/** When the conversation was last active. Before the first status there is
 *  no clock to measure it against. */
const activityOf = (view: ThreadView, now: number): string =>
  view.lastActivityAt === undefined || now === 0
    ? "archived"
    : `last active ${elapsedOf(view.lastActivityAt, now)} ago`;

const archivedRow = (bot: string, view: ThreadView, now: number, h: HtmlBuilder<Message>): Html => {
  // The main conversation is never archived, so every archived one names a thread.
  const thread = view.thread ?? "";
  return h.keyed("div")(
    thread,
    [h.Class("doneitem archived-item"), h.DataAttribute("thread", thread)],
    [
      h.span(
        [h.Class("runit-main")],
        [
          h.span([h.Class("rt")], [archivedLabel(view)]),
          h.span([h.Class("rmeta")], [activityOf(view, now)]),
        ],
      ),
      button(
        {
          className: "btn ghost",
          data: [["restore", thread]],
          ariaLabel: `Restore ${archivedLabel(view)}`,
          onClick: Message.ClickedRestoreThread({ bot, thread }),
        },
        ["Restore"],
        h,
      ),
    ],
  );
};

/** Why there is no list on screen: it has not arrived, or it could not be read. */
const notice = (channel: Channel | undefined, h: HtmlBuilder<Message>): Html => {
  const error = channel === undefined ? undefined : errorOf(channel.archived);
  return h.div(
    [h.Class("empty")],
    [
      h.p(
        [],
        [
          error === undefined
            ? "Reading the archive…"
            : `Couldn't read the archived conversations (${error}).`,
        ],
      ),
    ],
  );
};

export const archive = (bot: string, model: Model, h: HtmlBuilder<Message>): Html => {
  const channel = model.channels[bot];
  const loaded = channel !== undefined && dataOf(channel.archived) !== undefined;
  const threads = archivedThreadsOf(channel);

  const body: readonly Html[] = !loaded
    ? [notice(channel, h)]
    : threads.length === 0
      ? [
          h.div(
            [h.Class("empty")],
            [
              h.strong([], [`No archived conversations with ${botName(bot)}`]),
              h.p([], ["A conversation you archive shows up here, ready to restore."]),
            ],
          ),
        ]
      : [
          h.section(
            [h.Class("grp"), h.AriaLabel(`Archived conversations with ${botName(bot)}`)],
            threads.map((view) => archivedRow(bot, view, model.now, h)),
          ),
        ];

  return h.div(
    [h.Class("screen")],
    [
      h.header(
        [h.Class("hdr")],
        [
          button(
            {
              className: "icon",
              ariaLabel: `Back to ${botName(bot)}`,
              onClick: Message.ClickedOpenTranscript({ bot }),
            },
            ["‹"],
            h,
          ),
          avatar(bot, h),
          h.span(
            [h.Class("hdr-main stacked")],
            [
              h.h1([], ["Archived"]),
              h.span(
                [h.Class("hdr-sub")],
                [loaded ? `${threads.length} with ${botName(bot)}` : botName(bot)],
              ),
            ],
          ),
        ],
      ),
      h.main([h.Class("scroll")], [...body, h.div([h.Class("pad")])]),
      ...toast(model, h),
    ],
  );
};
