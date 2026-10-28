import type {
  ActiveRunView,
  ApprovalView,
  BotView,
  EntryView,
  TranscriptPage,
} from "@mackbot/contract";
import { Option } from "effect";
import { AsyncData } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { clockOf, elapsedOf, wordsOf } from "./format.ts";
import { Message } from "./message.ts";
import type { Channel, Model } from "./model.ts";
import { avatar, botName, modelLabel, runTitle, statusTag, toast } from "./partials.ts";

const statusIn = (channel: Channel | undefined): Option.Option<BotView> =>
  Option.match(Option.fromNullishOr(channel), {
    onNone: () => Option.none(),
    onSome: (present) => AsyncData.getData(present.status),
  });

const pageIn = (channel: Channel | undefined): Option.Option<TranscriptPage> =>
  Option.match(Option.fromNullishOr(channel), {
    onNone: () => Option.none(),
    onSome: (present) => AsyncData.getData(present.transcript),
  });

const entriesIn = (channel: Channel | undefined): readonly EntryView[] =>
  Option.match(pageIn(channel), { onNone: () => [], onSome: (page) => page.entries });

const draftIn = (channel: Channel | undefined): string => channel?.draft ?? "";
const sendingIn = (channel: Channel | undefined): boolean => channel?.sending ?? false;
const pendingIn = (channel: Channel | undefined): readonly string[] => channel?.pending ?? [];

const awaitingIn = (bot: string, channel: Channel | undefined): readonly ApprovalView[] =>
  Option.match(statusIn(channel), {
    onNone: () => [],
    onSome: (status) =>
      status.approvals.filter((approval) => approval.status === "pending" && approval.bot === bot),
  });

const originOf = (entry: EntryView): string | undefined => {
  if (entry.role !== "assistant") return undefined;
  if (entry.origin === undefined || entry.origin === "http") return undefined;
  return entry.at === undefined ? entry.origin : `${entry.origin} · ${clockOf(entry.at)}`;
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

/**
 * A tool result is model context, not a chat message. It collapses to a row a
 * person can scan — tool name and outcome — and opens on demand for the raw
 * payload. A failed result starts open, because that is the one a person needs.
 */
const toolRow = (entry: EntryView, h: HtmlBuilder<Message>): Html => {
  const failed = entry.toolFailed === true;

  return h.keyed("details")(
    `tool:${entry.id}`,
    [
      h.Class("tool"),
      h.DataAttribute("entry", `${entry.id}`),
      h.DataAttribute("tool", entry.toolName ?? ""),
      ...(failed ? [h.Open(true)] : []),
    ],
    [
      h.summary(
        [h.Class("tool-summary")],
        [
          h.span([h.Class(failed ? "tag warn" : "tag")], ["tool"]),
          h.span([h.Class("tool-name")], [entry.toolName ?? "tool result"]),
          h.span([h.Class("tool-meta")], [failed ? "failed" : "ok"]),
          h.span([h.Class("chev")], ["›"]),
        ],
      ),
      h.pre([h.Class("tool-body")], [entry.text]),
    ],
  );
};

/**
 * One entry as a row, or nothing at all. A tool result is a row of its own; a
 * message whose text is empty is the turn's plumbing, and a person reading the
 * thread has nothing to gain from a bubble with no words in it.
 */
const rowOf = (entry: EntryView, h: HtmlBuilder<Message>): readonly Html[] => {
  if (entry.role === "tool") return [toolRow(entry, h)];
  return wordsOf(entry) === undefined ? [] : [messageRow(entry, h)];
};

const pendingRow = (text: string, index: number, h: HtmlBuilder<Message>): Html =>
  h.keyed("div")(
    `pending:${index}:${text}`,
    [h.Class("msg me pending"), h.DataAttribute("pending", "")],
    [h.p([], [text])],
  );

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

const runRow = (bot: string, run: ActiveRunView, now: number, h: HtmlBuilder<Message>): Html =>
  h.keyed("div")(
    "run",
    [h.Class("streamline")],
    [
      avatar(bot, h),
      h.div(
        [h.Class("runit-main")],
        [
          h.p([h.Class("live")], [`${runTitle(run)} — running ${elapsedOf(run.startedAt, now)}`]),
          h.span([h.Class("bar indeterminate")], [h.i([])]),
        ],
      ),
    ],
  );

/**
 * The route pages backwards by entry id, so the only way to reach an older page
 * is this button. It is the `nextBefore` cursor made clickable; without it the
 * cursor would never be spent.
 */
const earlierRow = (bot: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [],
    [
      h.button(
        [
          h.Class("btn ghost"),
          h.DataAttribute("load", "earlier"),
          h.OnClick(Message.ClickedLoadEarlier({ bot })),
        ],
        ["Load earlier"],
      ),
    ],
  );

export const transcript = (bot: string, model: Model, h: HtmlBuilder<Message>): Html => {
  const channel = model.channels[bot];
  const status = statusIn(channel);
  const run = Option.flatMap(status, (view) => Option.fromNullishOr(view.activeRun));
  const draft = draftIn(channel);
  const sending = sendingIn(channel);
  const pending = pendingIn(channel);

  const body: readonly Html[] = [
    h.div([h.Class("dayline")], ["Today"]),
    ...Option.match(pageIn(channel), {
      onNone: () => [],
      onSome: (page) => (page.nextBefore === undefined ? [] : [earlierRow(bot, h)]),
    }),
    ...entriesIn(channel).flatMap((entry) => rowOf(entry, h)),
    ...(entriesIn(channel).length === 0 && pending.length === 0
      ? [
          h.div(
            [h.Class("empty")],
            [
              h.strong([], [`No messages with ${botName(bot)} yet`]),
              h.p([], ["Send the first one below."]),
            ],
          ),
        ]
      : []),
    ...pending.map((text, index) => pendingRow(text, index, h)),
    ...awaitingIn(bot, channel).map((approval) => awaitingRow(approval, h)),
    ...Option.match(run, {
      onNone: () => [],
      onSome: (active) => [runRow(bot, active, model.now, h)],
    }),
    h.div([h.Class("pad")]),
  ];

  const composer = h.form(
    [h.Class("composer"), h.OnSubmit(Message.SubmittedChat({ bot }))],
    [
      h.textarea([
        h.Class("input composer-input"),
        h.DataAttribute("field", "chat"),
        h.Value(draft),
        h.Placeholder(`Message ${botName(bot)}…`),
        h.AriaLabel(`Message ${botName(bot)}`),
        h.OnInput((text) => Message.EditedChatText({ bot, text })),
      ]),
      h.button(
        [
          h.Class("btn primary composer-send"),
          h.Type("submit"),
          h.Disabled(sending || draft.trim().length === 0),
        ],
        [sending ? "Sending…" : "Send"],
      ),
    ],
  );

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
      composer,
      ...toast(model.toast, h),
    ],
  );
};
