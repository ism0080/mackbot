import type { ActiveRunView, ApprovalView, BotView, EntryView } from "@mackbot/web-contract";
import { Option } from "effect";
import { AsyncData } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { clockOf, elapsedOf } from "./format.ts";
import { FIXTURE_NOW } from "./fixture.ts";
import { Message } from "./message.ts";
import type { Channel, Model } from "./model.ts";
import { avatar, botName, modelLabel, statusTag } from "./partials.ts";

const runTitle = (run: ActiveRunView): string => run.inputs[0] ?? "Working";

const statusIn = (channel: Channel | undefined): Option.Option<BotView> =>
  Option.match(Option.fromNullishOr(channel), {
    onNone: () => Option.none(),
    onSome: (present) => AsyncData.getData(present.status),
  });

const entriesIn = (channel: Channel | undefined): readonly EntryView[] =>
  Option.match(Option.fromNullishOr(channel), {
    onNone: () => [],
    onSome: (present) =>
      Option.match(AsyncData.getData(present.transcript), {
        onNone: () => [],
        onSome: (page) => page.entries,
      }),
  });

const awaitingIn = (bot: string, channel: Channel | undefined): readonly ApprovalView[] =>
  Option.match(statusIn(channel), {
    onNone: () => [],
    onSome: (status) =>
      status.approvals.filter(
        (approval) => approval.status === "pending" && approval.bot === bot,
      ),
  });

const originOf = (entry: EntryView): string | undefined => {
  if (entry.role !== "assistant") return undefined;
  if (entry.origin === undefined || entry.origin === "http") return undefined;
  return entry.at === undefined
    ? entry.origin
    : `${entry.origin} · ${clockOf(entry.at)}`;
};

const messageRow = (entry: EntryView, h: HtmlBuilder<Message>): Html => {
  const origin = originOf(entry);

  return h.keyed("div")(
    entry.id,
    [
      h.Class(entry.role === "user" ? "msg me" : "msg bot"),
      h.DataAttribute("entry", `${entry.id}`),
    ],
    [
      ...(origin === undefined ? [] : [h.span([h.Class("origin")], [origin])]),
      h.p([], [entry.text]),
    ],
  );
};

const awaitingRow = (approval: ApprovalView, h: HtmlBuilder<Message>): Html =>
  h.keyed("button")(
    approval.approvalId,
    [
      h.Class("ap-ref"),
      h.DataAttribute("approval", approval.approvalId),
      h.OnClick(Message.ClickedBack()),
    ],
    [
      h.span([h.Class("tag warn")], ["approval"]),
      h.span([h.Class("ap-ref-text")], ["Waiting on you. Decide it in Needs you."]),
      h.span([h.Class("chev")], ["›"]),
    ],
  );

const runRow = (bot: string, run: ActiveRunView, h: HtmlBuilder<Message>): Html =>
  h.keyed("div")(
    "run",
    [h.Class("streamline")],
    [
      avatar(bot, h),
      h.div(
        [h.Class("runit-main")],
        [
          h.p(
            [h.Class("live")],
            [`${runTitle(run)} — running ${elapsedOf(run.startedAt, FIXTURE_NOW)}`],
          ),
          h.span([h.Class("bar indeterminate")], [h.i([])]),
        ],
      ),
    ],
  );

export const transcript = (bot: string, model: Model, h: HtmlBuilder<Message>): Html => {
  const channel = model.channels[bot];
  const status = statusIn(channel);
  const run = Option.flatMap(status, (view) => Option.fromNullishOr(view.activeRun));

  const body: readonly Html[] = [
    h.div([h.Class("dayline")], ["Today"]),
    ...entriesIn(channel).map((entry) => messageRow(entry, h)),
    ...awaitingIn(bot, channel).map((approval) => awaitingRow(approval, h)),
    ...Option.match(run, {
      onNone: () => [],
      onSome: (active) => [runRow(bot, active, h)],
    }),
    h.div([h.Class("pad")]),
  ];

  return h.div(
    [h.Class("screen")],
    [
      h.header(
        [h.Class("hdr")],
        [
          h.button(
            [
              h.Class("icon"),
              h.AriaLabel("Back to Needs you"),
              h.OnClick(Message.ClickedBack()),
            ],
            ["‹"],
          ),
          avatar(bot, h),
          h.span(
            [h.Class("hdr-main stacked")],
            [
              h.h1([], [botName(bot)]),
              h.span(
                [h.Class("hdr-sub")],
                [
                  Option.match(status, {
                    onNone: () => "no status",
                    onSome: (view) => modelLabel(view),
                  }),
                ],
              ),
            ],
          ),
          Option.match(status, {
            onNone: () => h.span([h.Class("tag")], ["unknown"]),
            onSome: (view) => statusTag(view, h),
          }),
        ],
      ),
      h.main([h.Class("scroll")], body),
    ],
  );
};
