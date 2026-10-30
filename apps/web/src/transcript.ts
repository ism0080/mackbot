import type { ActiveRunView, ApprovalView, EntryView, LiveToolView } from "@mackbot/contract";
import { Option } from "effect";
import { Disclosure } from "@foldkit/ui";
import type { Html, HtmlBuilder, KeyboardModifiers } from "foldkit/html";

import { pageOf, statusOf } from "./channel.ts";
import { clockOf, dayKeyOf, dayLabelOf, elapsedOf, wordsOf } from "./format.ts";
import { parseMarkdown, renderMarkdown } from "./markdown.ts";
import { Message } from "./message.ts";
import type { Channel, Model, PendingMessage } from "./model.ts";
import { avatar, botName, modelLabel, runTitle, statusTag, toast } from "./partials.ts";
import { isExpanded } from "./select.ts";
import { stepsOf, stepsRail, stepNow } from "./steps.ts";
import { button } from "./ui.ts";

const entriesIn = (channel: Channel | undefined): readonly EntryView[] =>
  Option.match(pageOf(channel), { onNone: () => [], onSome: (page) => page.entries });

const draftIn = (channel: Channel | undefined): string => channel?.draft ?? "";
const sendingIn = (channel: Channel | undefined): boolean => channel?.sending ?? false;
const pendingIn = (channel: Channel | undefined): readonly PendingMessage[] =>
  channel?.pending ?? [];

const awaitingIn = (bot: string, channel: Channel | undefined): readonly ApprovalView[] =>
  Option.match(statusOf(channel), {
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
                    h.span([h.Class("chev"), h.AriaHidden(true)], ["›"]),
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

const dayline = (key: string, label: string, h: HtmlBuilder<Message>): Html =>
  h.keyed("div")(`day:${key}`, [h.Class("dayline")], [label]);

/**
 * The thread's rows with a divider wherever the local day changes, so a thread
 * that spans a week says which day each part was said on. An entry with no
 * time stays under the day before it. `lastDay` is the key of the last
 * divider, which the pending bubbles read to decide whether they need a
 * "Today" of their own.
 */
const threadRows = (
  entries: readonly EntryView[],
  model: Model,
  h: HtmlBuilder<Message>,
): Readonly<{ rows: readonly Html[]; lastDay: string | undefined }> => {
  const rows: Html[] = [];
  let lastDay: string | undefined;
  for (const entry of entries) {
    const entryRows = rowOf(entry, model, h);
    if (entryRows.length > 0 && entry.at !== undefined && dayKeyOf(entry.at) !== lastDay) {
      lastDay = dayKeyOf(entry.at);
      rows.push(dayline(lastDay, dayLabelOf(entry.at, model.now), h));
    }
    rows.push(...entryRows);
  }
  return { rows, lastDay };
};

const pendingRow = (message: PendingMessage, index: number, h: HtmlBuilder<Message>): Html =>
  h.keyed("div")(
    `pending:${message.after}:${index}`,
    [h.Class("msg me pending"), h.DataAttribute("pending", "")],
    [h.p([], [message.text])],
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
      h.span([h.Class("chev"), h.AriaHidden(true)], ["›"]),
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
const earlierRow = (bot: string, loading: boolean, h: HtmlBuilder<Message>): Html =>
  h.div(
    [],
    [
      button(
        {
          className: "btn ghost",
          data: [["load", "earlier"]],
          isDisabled: loading,
          onClick: Message.ClickedLoadEarlier({ bot }),
        },
        ["Load earlier"],
        h,
      ),
    ],
  );

/**
 * Enter sends and Shift+Enter starts a new line, the way a chat box reads. A
 * key held with another modifier is left to the browser. While an input method
 * is composing, the browser reports the key as `Process` rather than `Enter`,
 * so the Enter that commits a composition never sends a half-written message.
 */
const sendOnEnter =
  (bot: string) =>
  (key: string, modifiers: KeyboardModifiers): Option.Option<Message> =>
    key === "Enter" &&
    !modifiers.shiftKey &&
    !modifiers.altKey &&
    !modifiers.ctrlKey &&
    !modifiers.metaKey
      ? Option.some(Message.SubmittedChat({ bot }))
      : Option.none();

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
            h.EnterKeyHint("send"),
            h.OnInput((text) => Message.EditedChatText({ bot, text })),
            h.OnKeyDownPreventDefault(sendOnEnter(bot)),
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
  const status = statusOf(channel);
  const run = Option.flatMap(status, (view) => Option.fromNullishOr(view.activeRun));
  const draft = draftIn(channel);
  const sending = sendingIn(channel);
  const pending = pendingIn(channel);
  const steps = stepsOf(channel);
  const entries = entriesIn(channel);
  const thread = threadRows(entries, model, h);
  // A message being sent now is said today, so it gets a "Today" of its own
  // when the thread's last word was said on another day. Before the first
  // status there is no clock to say which day today is.
  const today = model.now === 0 ? undefined : dayKeyOf(model.now);
  const pendingDay =
    pending.length > 0 && today !== undefined && thread.lastDay !== today
      ? [dayline(today, "Today", h)]
      : [];

  const body: readonly Html[] = [
    ...Option.match(pageOf(channel), {
      onNone: () => [],
      onSome: (page) =>
        page.nextBefore === undefined ? [] : [earlierRow(bot, channel?.loadingEarlier ?? false, h)],
    }),
    ...thread.rows,
    ...(entries.length === 0 && pending.length === 0
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
    ...pendingDay,
    ...pending.map((message, index) => pendingRow(message, index, h)),
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
      // The thread is a log: a screen reader hears what arrives without the
      // person having to move back through the conversation to find it.
      h.main(
        [
          h.Class("scroll"),
          h.Id("transcript-scroll"),
          h.Role("log"),
          h.AriaLive("polite"),
          h.AriaLabel(`Conversation with ${botName(bot)}`),
        ],
        body,
      ),
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
