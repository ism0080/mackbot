import type { ActiveRunView, ApprovalView } from "@mackbot/contract";
import { Dialog } from "@foldkit/ui";
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html";

import { elapsedOf } from "./format.ts";
import { Message } from "./message.ts";
import type { Model } from "./model.ts";
import { avatar, botName, runTitle, toast } from "./partials.ts";
import {
  entryStampOf,
  selectChats,
  selectHome,
  selectReview,
  selectStatusPanel,
} from "./select.ts";
import type { Chat } from "./select.ts";
import { failurePanel, parkedPanel, taskPanel } from "./status-panel.ts";
import { isParked } from "./task-retry.ts";
import { button, runningBar } from "./ui.ts";

/**
 * The way into the draft. An approval that authorizes a real effect has to show
 * the effect, and a two-line peek is not reading it: this opens the artifact at
 * full size in a dialog, where the whole draft and the decision sit together.
 */
const draftOf = (bot: string, approval: ApprovalView, h: HtmlBuilder<Message>): readonly Html[] => {
  const artifact = approval.artifact;
  if (artifact === undefined) return [];

  return [
    button(
      {
        className: "ap-draft",
        data: [["review", approval.approvalId]],
        onClick: Message.ClickedReviewApproval({ bot, approvalId: approval.approvalId }),
      },
      [
        h.span([h.Class("ap-draft-label")], [artifact.label]),
        h.span([h.Class("ap-draft-peek")], [artifact.body]),
      ],
      h,
    ),
  ];
};

/** The dialog's body: the draft, the question it asks, and the decision. */
const reviewPanel = (
  bot: string,
  approval: ApprovalView,
  title: ReadonlyArray<ChildAttribute>,
  description: ReadonlyArray<ChildAttribute>,
  closeButton: ReadonlyArray<ChildAttribute>,
  h: HtmlBuilder<Message>,
): readonly Html[] => {
  const artifact = approval.artifact;

  return [
    h.span([h.Class("tag warn")], ["approval"]),
    h.h2([...title, h.Class("dlg-title")], [artifact?.label ?? approval.toolPath]),
    h.p([...description, h.Class("dlg-question")], [approval.summary]),
    ...(artifact === undefined ? [] : [h.pre([h.Class("dlg-artifact")], [artifact.body])]),
    h.div(
      [h.Class("dlg-actions")],
      [
        button(
          {
            className: "btn ghost",
            onClick: Message.DecidedApproval({
              bot,
              approvalId: approval.approvalId,
              action: "deny",
            }),
          },
          ["Deny"],
          h,
        ),
        button(
          {
            className: "btn primary",
            onClick: Message.DecidedApproval({
              bot,
              approvalId: approval.approvalId,
              action: "allow",
            }),
          },
          ["Allow"],
          h,
        ),
        // The escape hatch needs no Message of its own: the bundle closes the
        // dialog, and the fold clears what was under review.
        h.button([...closeButton, h.Class("dlg-close")], ["Close"]),
      ],
    ),
    h.span([h.Class("dlg-tool")], [approval.toolPath]),
  ];
};

/**
 * The approval under review, read at full size. The native dialog traps the
 * focus, makes the screen behind it inert and closes on Escape, so the decision
 * is taken with the whole draft in front of the person.
 */
const reviewDialog = (model: Model, h: HtmlBuilder<Message>): Html => {
  const review = selectReview(model);

  return h.submodel({
    slotId: model.dialog.id,
    model: model.dialog,
    view: Dialog.view,
    viewInputs: {
      hasDescription: review !== null,
      toView: ({ dialog, backdrop, panel, title, description, closeButton, isVisible }) =>
        h.dialog(
          [...dialog, h.Class("dlg")],
          isVisible
            ? [
                h.div([...backdrop, h.Class("dlg-backdrop")]),
                h.div(
                  [...panel, h.Class("dlg-panel")],
                  review === null
                    ? [
                        h.p([h.Class("dlg-question")], ["That approval is no longer waiting."]),
                        h.div(
                          [h.Class("dlg-actions")],
                          [h.button([...closeButton, h.Class("dlg-close")], ["Close"])],
                        ),
                      ]
                    : reviewPanel(review.bot, review.approval, title, description, closeButton, h),
                ),
              ]
            : [],
        ),
    },
    toParentMessage: (message) => Message.GotDialogMessage({ message }),
  });
};

const approvalCard = (
  bot: string,
  approval: ApprovalView,
  now: number,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed("div")(
    approval.approvalId,
    [
      h.Class("approval"),
      h.DataAttribute("approval", approval.approvalId),
      h.DataAttribute("bot", bot),
    ],
    [
      h.div(
        [h.Class("ap-head")],
        [
          h.span([h.Class("tag warn")], ["approval"]),
          h.span([h.Class("ap-tool")], [approval.toolPath]),
          button(
            {
              className: "ap-review",
              onClick: Message.ClickedOpenTranscript({ bot }),
            },
            ["Review ›"],
            h,
          ),
        ],
      ),
      h.p([h.Class("ap-q")], [approval.summary]),
      ...draftOf(bot, approval, h),
      h.div(
        [h.Class("ap-actions")],
        [
          button(
            {
              className: "btn ghost",
              onClick: Message.DecidedApproval({
                bot,
                approvalId: approval.approvalId,
                action: "deny",
              }),
            },
            ["Deny"],
            h,
          ),
          button(
            {
              className: "btn primary",
              onClick: Message.DecidedApproval({
                bot,
                approvalId: approval.approvalId,
                action: "allow",
              }),
            },
            ["Allow"],
            h,
          ),
        ],
      ),
      h.div([h.Class("ap-foot")], [`waiting ${elapsedOf(approval.requestedAt, now)} · ${bot}`]),
    ],
  );

const runningRow = (bot: string, run: ActiveRunView, now: number, h: HtmlBuilder<Message>): Html =>
  h.keyed("div")(
    bot,
    [h.Class("runit"), h.DataAttribute("bot", bot)],
    [
      avatar(bot, h),
      h.div(
        [h.Class("runit-main")],
        [
          h.span([h.Class("rt")], [runTitle(run)]),
          h.span(
            [h.Class("rmeta")],
            [`running ${elapsedOf(run.startedAt, now)} · ${run.stream.state}`],
          ),
          runningBar({ id: `run-${bot}`, valueText: `${runTitle(run)} is still running` }, h),
        ],
      ),
      button(
        {
          className: "btn ghost",
          data: [["stop", bot]],
          onClick: Message.ClickedStop({ bot, session: run.session }),
        },
        ["Stop"],
        h,
      ),
    ],
  );

const recentRow = (bot: string, text: string, stamp: string, h: HtmlBuilder<Message>): Html =>
  h.keyed("button")(
    bot,
    [
      h.Class("doneitem"),
      h.DataAttribute("bot", bot),
      h.OnClick(Message.ClickedOpenTranscript({ bot })),
    ],
    [
      avatar(bot, h),
      h.span(
        [h.Class("runit-main")],
        [
          h.span([h.Class("rt")], [text]),
          h.span([h.Class("rmeta")], [`${botName(bot)} · ${stamp}`]),
        ],
      ),
      h.span([h.Class("chev")], ["›"]),
    ],
  );

/**
 * One thread in the persistent chats list. The row is the way back into any
 * conversation after the triage sections — blocked, running, recent — have
 * stopped mentioning it.
 */
const chatRow = (chat: Chat, h: HtmlBuilder<Message>): Html =>
  h.keyed("button")(
    chat.bot,
    [
      h.Class("chatitem"),
      h.DataAttribute("bot", chat.bot),
      h.AriaLabel(`Open chat with ${botName(chat.bot)}`),
      h.OnClick(Message.ClickedOpenTranscript({ bot: chat.bot })),
    ],
    [
      avatar(chat.bot, h),
      h.span(
        [h.Class("runit-main")],
        [
          h.span([h.Class("rt")], [botName(chat.bot)]),
          h.span(
            [h.Class("rmeta chat-preview")],
            [chat.stamp.length === 0 ? chat.preview : `${chat.preview} · ${chat.stamp}`],
          ),
        ],
      ),
      chat.busy ? h.span([h.Class("tag work")], ["working"]) : h.span([h.Class("tag")], ["idle"]),
      h.span([h.Class("chev")], ["›"]),
    ],
  );

export const home = (model: Model, h: HtmlBuilder<Message>): Html => {
  const triage = selectHome(model);
  const panel = selectStatusPanel(model);
  const chats = selectChats(model);

  // A parked task has its own section, so the live work lists only the tasks
  // the harness will pick up on its own.
  const live = panel.tasks.flatMap(({ bot, tasks }) => {
    const rows = taskPanel(
      bot,
      tasks.filter((task) => !isParked(task)),
      h,
    );
    return rows.length === 0 ? [] : [{ bot, rows }];
  });
  const parked = panel.tasks.flatMap(({ bot, tasks }) => {
    const rows = parkedPanel(bot, tasks, h);
    return rows.length === 0 ? [] : [{ bot, rows }];
  });

  return h.div(
    [h.Class("screen")],
    [
      h.header(
        [h.Class("hdr tall")],
        [
          h.h1([], [triage.headline]),
          h.span([h.Class("hdr-sub")], [triage.sub]),
          h.div(
            [h.Class("hdr-actions")],
            [
              button(
                {
                  className: "btn ghost",
                  data: [["open", "new-chat"]],
                  onClick: Message.ClickedNewChat(),
                },
                ["New chat"],
                h,
              ),
              button(
                {
                  className: "btn ghost",
                  data: [["open", "bots"]],
                  onClick: Message.ClickedOpenBots(),
                },
                ["Bots"],
                h,
              ),
            ],
          ),
        ],
      ),
      h.main(
        [h.Class("scroll")],
        [
          h.section(
            [h.Class("grp"), h.DataAttribute("group", "error"), h.Hidden(triage.notice === null)],
            [h.div([h.Class("empty")], [h.p([], [triage.notice ?? ""])])],
          ),
          h.section(
            [
              h.Class("grp"),
              h.DataAttribute("group", "failures"),
              h.Hidden(panel.failures.length === 0),
            ],
            [
              h.h2([], ["Needs attention"]),
              ...panel.failures.flatMap(({ bot, failures }) =>
                failurePanel(bot, failures, model.now, h),
              ),
            ],
          ),
          h.section(
            [
              h.Class("grp"),
              h.DataAttribute("group", "blocked"),
              h.Hidden(triage.blocked.length === 0),
            ],
            [
              h.h2([], ["Blocked on you"]),
              ...triage.blocked.map(({ bot, approval }) =>
                approvalCard(bot, approval, model.now, h),
              ),
            ],
          ),
          h.section(
            [h.Class("grp"), h.DataAttribute("group", "empty"), h.Hidden(!triage.allClear)],
            [
              h.div(
                [h.Class("empty")],
                [
                  h.span([h.Class("empty-mark"), h.AriaHidden(true)], ["✓"]),
                  h.strong([], ["Nothing needs you"]),
                  h.p([], [triage.clearNote]),
                ],
              ),
            ],
          ),
          h.section(
            [
              h.Class("grp"),
              h.DataAttribute("group", "running"),
              h.Hidden(triage.running.length === 0),
            ],
            [
              h.h2([], ["Running now"]),
              ...triage.running.map(({ bot, run }) => runningRow(bot, run, model.now, h)),
            ],
          ),
          h.section(
            [h.Class("grp"), h.DataAttribute("group", "chats"), h.Hidden(chats.length === 0)],
            [h.h2([], ["Chats"]), ...chats.map((chat) => chatRow(chat, h))],
          ),
          h.section(
            [h.Class("grp"), h.DataAttribute("group", "tasks"), h.Hidden(live.length === 0)],
            [h.h2([], ["Live work"]), ...live.flatMap(({ rows }) => rows)],
          ),
          h.section(
            [h.Class("grp"), h.DataAttribute("group", "parked"), h.Hidden(parked.length === 0)],
            [h.h2([], ["Parked"]), ...parked.flatMap(({ rows }) => rows)],
          ),
          h.section(
            [
              h.Class("grp"),
              h.DataAttribute("group", "recent"),
              h.Hidden(triage.recent.length === 0),
            ],
            [
              h.h2([], ["Since you last looked"]),
              ...triage.recent.map(({ bot, entry }) =>
                recentRow(bot, entry.text, entryStampOf(entry), h),
              ),
            ],
          ),
          h.div([h.Class("pad")]),
        ],
      ),
      ...toast(model, h),
      reviewDialog(model, h),
    ],
  );
};
