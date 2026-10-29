import type {
  ActiveRunView,
  ApprovalView,
  BotView,
  EntryView,
  LiveToolView,
  TranscriptPage,
} from "@mackbot/contract";
import { Option } from "effect";
import { AsyncData } from "foldkit";
import { Disclosure } from "@foldkit/ui";
import type { Html, HtmlBuilder } from "foldkit/html";

import { clockOf, elapsedOf, wordsOf } from "./format.ts";
import { parseMarkdown, renderMarkdown } from "./markdown.ts";
import { Message } from "./message.ts";
import type { Channel, Model } from "./model.ts";
import { avatar, botName, modelLabel, runTitle, statusTag, toast } from "./partials.ts";
import { isExpanded } from "./select.ts";
import { stepsOf, stepsRail, stepNow } from "./steps.ts";
import { button } from "./ui.ts";

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

/**
 * The blocks a long message keeps before the rest moves behind a summary. A
 * check-in that reports a whole week is longer than a screen, and what follows
 * it is the part a person acts on, so the tail folds rather than truncates:
 * the disclosure opens in place, with nothing thrown away.
 */
const COLLAPSED_BLOCKS = 6;

/** An assistant entry's words, as the markdown blocks the prose is written in. */
const messageBody = (
  entry: EntryView,
  text: string,
  model: Model,
  h: HtmlBuilder<Message>,
): Html => {
  const blocks = parseMarkdown(text);
  if (blocks.length <= COLLAPSED_BLOCKS) {
    return h.div([h.Class("md")], renderMarkdown(blocks, h));
  }

  const tail = blocks.slice(COLLAPSED_BLOCKS);
  const id = `rest:${entry.id}`;

  return h.div(
    [h.Class("md")],
    [
      ...renderMarkdown(blocks.slice(0, COLLAPSED_BLOCKS), h),
      // The disclosure's open state is the Model's, so the tail a person opened
      // stays open when the poll re-renders the entry underneath them.
      Disclosure.view(
        {
          id,
          isOpen: isExpanded(model, id),
          onToggle: (isOpen) => Message.ToggledPanel({ id, isOpen }),
          toView: ({ button: toggle, panel, animatePanel }) =>
            h.div(
              [h.Class("md-clip")],
              [
                h.button(
                  [...toggle, h.Class("md-clip-toggle")],
                  [`Show the rest · ${tail.length} more`],
                ),
                h.div([...panel], [animatePanel(h.div([], renderMarkdown(tail, h)))]),
              ],
            ),
        },
        h,
      ),
    ],
  );
};

const messageRow = (
  entry: EntryView,
  words: string,
  model: Model,
  h: HtmlBuilder<Message>,
): Html => {
  const origin = originOf(entry);

  return h.keyed("div")(
    entry.id,
    [
      h.Class(entry.role === "user" ? "msg me" : "msg bot"),
      h.DataAttribute("entry", `${entry.id}`),
    ],
    [
      // A person's own words are plain text, so the bubble keeps them verbatim.
      // A bot writes markdown, and rendering it is the difference between a
      // bulleted list and one long line of asterisks and hyphens.
      entry.role === "assistant" ? messageBody(entry, words, model, h) : h.p([], [words]),
      // The origin is provenance, so it sits under the words like a byline
      // rather than pushing the first line of the message down.
      ...(origin === undefined
        ? []
        : [h.div([h.Class("msg-foot")], [h.span([h.Class("origin")], [origin])])]),
    ],
  );
};

/**
 * A tool result is model context, not a chat message. It collapses to a row a
 * person can scan — the tool, and whether it worked — and opens on demand for
 * the raw payload. A failed result starts open, because that is the one a
 * person needs, and stays closable because the open state is the Model's.
 */
const toolRow = (entry: EntryView, model: Model, h: HtmlBuilder<Message>): Html => {
  const failed = entry.toolFailed === true;
  const id = `tool:${entry.id}`;

  return h.keyed("div")(
    id,
    [
      h.Class("tool"),
      h.DataAttribute("entry", `${entry.id}`),
      h.DataAttribute("tool", entry.toolName ?? ""),
    ],
    [
      Disclosure.view(
        {
          id,
          isOpen: isExpanded(model, id, failed),
          onToggle: (isOpen) => Message.ToggledPanel({ id, isOpen }),
          toView: ({ button: toggle, panel, animatePanel }) =>
            h.div(
              [h.Class("tool-inner")],
              [
                h.button(
                  [...toggle, h.Class("tool-summary")],
                  [
                    h.span(
                      [h.Class(failed ? "state bad" : "state good"), h.AriaHidden(true)],
                      [failed ? "!" : "✓"],
                    ),
                    h.span([h.Class("tool-name")], [entry.toolName ?? "tool result"]),
                    h.span([h.Class("tool-meta")], [failed ? "failed" : "ok"]),
                    h.span([h.Class("chev")], ["›"]),
                  ],
                ),
                h.div([...panel], [animatePanel(h.pre([h.Class("tool-body")], [entry.text]))]),
              ],
            ),
        },
        h,
      ),
    ],
  );
};

/**
 * One entry as a row, or nothing at all. A tool result is a row of its own; a
 * message whose text is empty is the turn's plumbing, and a person reading the
 * thread has nothing to gain from a bubble with no words in it.
 */
const rowOf = (entry: EntryView, model: Model, h: HtmlBuilder<Message>): readonly Html[] => {
  if (entry.role === "tool") return [toolRow(entry, model, h)];
  const words = wordsOf(entry);
  return words === undefined ? [] : [messageRow(entry, words, model, h)];
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

/**
 * The run in hand, as the step it is on and the steps it has taken. The bar
 * names the step in the harness's own words rather than drawing a fraction of
 * one: a bot on step 4 of 7 is not 52% done, and the harness does not know how
 * many steps are left.
 */
const runRow = (
  bot: string,
  run: ActiveRunView,
  steps: readonly LiveToolView[],
  now: number,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed("div")(
    "run",
    [h.Class("streamline")],
    [
      avatar(bot, h),
      h.div(
        [h.Class("runit-main")],
        [
          h.div(
            [h.Class("think live")],
            [
              h.span([h.Class("sk")], [stepNow(steps) ?? runTitle(run)]),
              h.span([h.Class("t rmeta")], [`running ${elapsedOf(run.startedAt, now)}`]),
            ],
          ),
          ...(steps.length === 0 ? [] : [stepsRail(steps, h)]),
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
      button(
        {
          className: "btn ghost",
          data: [["load", "earlier"]],
          onClick: Message.ClickedLoadEarlier({ bot }),
        },
        ["Load earlier"],
        h,
      ),
    ],
  );

/**
 * The composer, as one shell rather than a field and a button side by side: the
 * whole block is the target, the model in play is named under the text, and
 * Enter sends. `Sending…` keeps the send button's accessible name in step with
 * what it will do, so a screen reader hears the state change.
 */
const composerOf = (
  bot: string,
  draft: string,
  sending: boolean,
  modelId: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.form(
    [h.Class("composer"), h.OnSubmit(Message.SubmittedChat({ bot }))],
    [
      h.div(
        [h.Class("pinput")],
        [
          h.textarea([
            h.Class("input composer-input"),
            h.DataAttribute("field", "chat"),
            h.Value(draft),
            h.Placeholder(`Message ${botName(bot)}…`),
            h.AriaLabel(`Message ${botName(bot)}`),
            h.OnInput((text) => Message.EditedChatText({ bot, text })),
          ]),
          h.div(
            [h.Class("prow")],
            [
              ...(modelId.length === 0 ? [] : [h.span([h.Class("pmodel")], [modelId])]),
              button(
                {
                  className: "send",
                  type: "submit",
                  isDisabled: sending || draft.trim().length === 0,
                  ariaLabel: sending ? "Sending…" : "Send",
                },
                ["↑"],
                h,
              ),
            ],
          ),
        ],
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
  const steps = stepsOf(channel);

  const body: readonly Html[] = [
    h.div([h.Class("dayline")], ["Today"]),
    ...Option.match(pageIn(channel), {
      onNone: () => [],
      onSome: (page) => (page.nextBefore === undefined ? [] : [earlierRow(bot, h)]),
    }),
    ...entriesIn(channel).flatMap((entry) => rowOf(entry, model, h)),
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
      onSome: (active) => [runRow(bot, active, steps, model.now, h)],
    }),
    // The end of the thread, named so the jump command has somewhere to aim.
    h.div([h.Class("pad"), h.Id("transcript-end")]),
  ];

  return h.div(
    [h.Class("screen")],
    [
      h.header(
        [h.Class("hdr")],
        [
          button(
            { className: "icon", ariaLabel: "Back to Needs you", onClick: Message.ClickedBack() },
            ["‹"],
            h,
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
      h.main([h.Class("scroll"), h.Id("transcript-scroll")], body),
      // Offered only while the thread has moved on without the person: at the
      // tail it would be a button that does nothing.
      ...(model.atBottom
        ? []
        : [
            button(
              {
                className: "fab",
                ariaLabel: "Jump to the latest message",
                onClick: Message.ClickedJumpToLatest(),
              },
              ["↓"],
              h,
            ),
          ]),
      composerOf(
        bot,
        draft,
        sending,
        Option.match(status, {
          onNone: () => "",
          onSome: (view) => view.model.id,
        }),
        h,
      ),
      ...toast(model, h),
    ],
  );
};
