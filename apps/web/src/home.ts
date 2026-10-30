import type { ActiveRunView, ApprovalView, LiveToolView } from "@mackbot/contract";
import { Dialog } from "@foldkit/ui";
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html";

import { elapsedOf, plainOf } from "./format.ts";
import { Message } from "./message.ts";
import type { Model } from "./model.ts";
import { avatar, botName, runTitle, toast } from "./partials.ts";
import type { FleetEntry } from "./select.ts";
import {
  entryStampOf,
  selectChats,
  selectFleet,
  selectHome,
  selectReview,
  selectStatusPanel,
} from "./select.ts";
import type { Chat } from "./select.ts";
import { failurePanel, parkedPanel, taskPanel } from "./status-panel.ts";
import { stepsOf, stepsRail, stepNow } from "./steps.ts";
import { isParked } from "./task-retry.ts";
import { button } from "./ui.ts";

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
        h.span(
          [h.Class("ap-draft-more")],
          ["Read the full draft ", h.span([h.AriaHidden(true)], ["›"])],
        ),
      ],
      h,
    ),
  ];
};

/**
 * The two decisions on an approval, wherever it is shown. A screen can list
 * several approvals at once, so each button's accessible name says which
 * approval it decides, beginning with the word it shows.
 */
const decisionButtons = (
  bot: string,
  approval: ApprovalView,
  h: HtmlBuilder<Message>,
): readonly Html[] => {
  const subject = `${approval.toolPath} for ${botName(bot)}`;
  const decide = (action: "allow" | "deny") =>
    Message.DecidedApproval({ bot, approvalId: approval.approvalId, action });

  return [
    button(
      { className: "btn ghost", ariaLabel: `Deny ${subject}`, onClick: decide("deny") },
      ["Deny"],
      h,
    ),
    button(
      { className: "btn primary", ariaLabel: `Allow ${subject}`, onClick: decide("allow") },
      ["Allow"],
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
        ...decisionButtons(bot, approval, h),
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

/**
 * One approval, as the thing the screen is for. The draft is the decision's
 * context, so it is one tappable block under the question rather than a link
 * beside it, and the two decisions sit under the draft where they are read.
 */
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
        ],
      ),
      h.p([h.Class("ap-q")], [approval.summary]),
      ...draftOf(bot, approval, h),
      h.div([h.Class("ap-actions")], decisionButtons(bot, approval, h)),
      h.div([h.Class("ap-foot")], [`waiting ${elapsedOf(approval.requestedAt, now)} · ${bot}`]),
    ],
  );

/**
 * A running bot: what the run is for, which step it is on, and the steps it has
 * already taken. The bar names the step rather than drawing a fraction of one,
 * because the harness knows which tool is running and not how many are left.
 */
const runningRow = (
  bot: string,
  run: ActiveRunView,
  steps: readonly LiveToolView[],
  now: number,
  h: HtmlBuilder<Message>,
): Html => {
  const current = stepNow(steps) ?? runTitle(run);

  return h.keyed("div")(
    bot,
    [h.Class("runit run"), h.DataAttribute("bot", bot)],
    [
      h.div(
        [h.Class("runhead")],
        [
          avatar(bot, h),
          h.span([h.Class("rt")], [runTitle(run)]),
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
      ),
      h.div(
        [h.Class("think")],
        [
          h.span([h.Class("sk")], [current]),
          h.span([h.Class("t rmeta")], [`running ${elapsedOf(run.startedAt, now)}`]),
        ],
      ),
      ...(steps.length === 0 ? [] : [stepsRail(steps, h)]),
    ],
  );
};

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
      h.span([h.Class("chev"), h.AriaHidden(true)], ["›"]),
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
      h.span([h.Class("chev"), h.AriaHidden(true)], ["›"]),
    ],
  );

/**
 * The fleet, as one always-present line. Every bot is here whatever it is
 * doing, and the dot is the state: a warm one needs a human, an accent one is
 * working, green is quiet. It is the strip that survives every empty section
 * below it, so the home never claims the fleet is gone.
 */
const fleetStrip = (fleet: readonly FleetEntry[], h: HtmlBuilder<Message>): Html => {
  const blocked = fleet.filter((entry) => entry.state === "blocked").length;

  return h.div(
    [h.Class("fleetbar")],
    [
      ...fleet.map(({ bot, state, label }) =>
        h.keyed("button")(
          bot,
          [
            h.Class("chip"),
            h.DataAttribute("fleet", bot),
            h.AriaLabel(`${botName(bot)}, ${label}`),
            h.OnClick(Message.ClickedOpenTranscript({ bot })),
          ],
          [avatar(bot, h), h.i([h.Class(`dot ${state}`), h.AriaHidden(true)])],
        ),
      ),
      h.span([h.Class("grow")]),
      h.span(
        [h.Class("qcount")],
        [
          blocked === 0
            ? `${fleet.length} ${fleet.length === 1 ? "bot" : "bots"}`
            : `${blocked} waiting on you`,
        ],
      ),
    ],
  );
};

export const home = (model: Model, h: HtmlBuilder<Message>): Html => {
  const triage = selectHome(model);
  const panel = selectStatusPanel(model);
  const chats = selectChats(model);
  const fleet = selectFleet(model);

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

  // Everything below the separator is the archive: threads that are not asking
  // for anything and the last answer from each bot. Work that is running or
  // parked sits above it, because a parked task is waiting on a human.
  const quiet = chats.length + triage.recent.length > 0;

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
              button(
                {
                  className: "btn ghost",
                  data: [["sign-out", ""]],
                  onClick: Message.ClickedSignOut(),
                },
                ["Sign out"],
                h,
              ),
            ],
          ),
        ],
      ),
      ...(fleet.length === 0 ? [] : [fleetStrip(fleet, h)]),
      h.main(
        [h.Class("scroll")],
        [
          h.section(
            [h.Class("grp"), h.DataAttribute("group", "error"), h.Hidden(triage.notice === null)],
            [
              h.div(
                [h.Class("banner")],
                [
                  h.span([h.Class("state bad"), h.AriaHidden(true)], ["!"]),
                  h.p([], [triage.notice ?? ""]),
                ],
              ),
            ],
          ),
          h.section(
            [
              h.Class("grp"),
              h.DataAttribute("group", "failures"),
              h.AriaLabel("Faults"),
              h.Hidden(panel.failures.length === 0),
            ],
            panel.failures.flatMap(({ bot, failures }) =>
              failurePanel(bot, failures, model.now, h),
            ),
          ),
          h.section(
            [
              h.Class("grp"),
              h.DataAttribute("group", "blocked"),
              h.AriaLabel("Blocked on you"),
              h.Hidden(triage.blocked.length === 0),
            ],
            triage.blocked.map(({ bot, approval }) => approvalCard(bot, approval, model.now, h)),
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
              h.AriaLabel("Running"),
              h.Hidden(triage.running.length === 0),
            ],
            triage.running.map(({ bot, run }) =>
              runningRow(bot, run, stepsOf(model.channels[bot]), model.now, h),
            ),
          ),
          h.section(
            [h.Class("grp"), h.DataAttribute("group", "tasks"), h.Hidden(live.length === 0)],
            live.flatMap(({ rows }) => rows),
          ),
          h.section(
            [h.Class("grp"), h.DataAttribute("group", "parked"), h.Hidden(parked.length === 0)],
            parked.flatMap(({ rows }) => rows),
          ),
          h.div([h.Class("sep"), h.DataAttribute("group", "quiet"), h.Hidden(!quiet)], ["quiet"]),
          h.section(
            [h.Class("grp"), h.DataAttribute("group", "chats"), h.Hidden(chats.length === 0)],
            chats.map((chat) => chatRow(chat, h)),
          ),
          h.section(
            [
              h.Class("grp"),
              h.DataAttribute("group", "recent"),
              h.Hidden(triage.recent.length === 0),
            ],
            triage.recent.map(({ bot, entry }) =>
              recentRow(bot, plainOf(entry.text), entryStampOf(entry), h),
            ),
          ),
          h.div([h.Class("pad")]),
        ],
      ),
      ...toast(model, h),
      reviewDialog(model, h),
    ],
  );
};
