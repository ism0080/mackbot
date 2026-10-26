import type { ActiveRunView, ApprovalView } from "@mackbot/contract";
import type { Html, HtmlBuilder } from "foldkit/html";

import { elapsedOf } from "./format.ts";
import { Message } from "./message.ts";
import type { Model } from "./model.ts";
import { avatar, botName, runTitle, toast } from "./partials.ts";
import { entryStampOf, selectHome, selectStatusPanel } from "./select.ts";
import { failurePanel, parkedPanel, taskPanel } from "./status-panel.ts";
import { isParked } from "./task-retry.ts";

const draftOf = (approval: ApprovalView, h: HtmlBuilder<Message>): readonly Html[] => {
  const artifact = approval.artifact;
  if (artifact === undefined) return [];

  return [
    h.details(
      [h.Class("ap-draft")],
      [
        h.summary(
          [],
          [
            h.span([h.Class("ap-draft-label")], [artifact.label]),
            h.span([h.Class("ap-draft-peek")], [artifact.body]),
          ],
        ),
        h.pre([], [artifact.body]),
      ],
    ),
  ];
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
          h.button(
            [h.Class("ap-review"), h.OnClick(Message.ClickedOpenTranscript({ bot }))],
            ["Review ›"],
          ),
        ],
      ),
      h.p([h.Class("ap-q")], [approval.summary]),
      ...draftOf(approval, h),
      h.div(
        [h.Class("ap-actions")],
        [
          h.button(
            [
              h.Class("btn ghost"),
              h.OnClick(
                Message.DecidedApproval({
                  bot,
                  approvalId: approval.approvalId,
                  action: "deny",
                }),
              ),
            ],
            ["Deny"],
          ),
          h.button(
            [
              h.Class("btn primary"),
              h.OnClick(
                Message.DecidedApproval({
                  bot,
                  approvalId: approval.approvalId,
                  action: "allow",
                }),
              ),
            ],
            ["Allow"],
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
          h.span([h.Class("bar indeterminate")], [h.i([])]),
        ],
      ),
      h.button(
        [
          h.Class("btn ghost"),
          h.DataAttribute("stop", bot),
          h.OnClick(Message.ClickedStop({ bot, session: run.session })),
        ],
        ["Stop"],
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

export const home = (model: Model, h: HtmlBuilder<Message>): Html => {
  const triage = selectHome(model);
  const panel = selectStatusPanel(model);

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
              h.button(
                [
                  h.Class("btn ghost"),
                  h.DataAttribute("open", "bots"),
                  h.OnClick(Message.ClickedOpenBots()),
                ],
                ["Bots"],
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
      ...toast(model.toast, h),
    ],
  );
};
