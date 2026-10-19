/**
 * status-panel — the home's rows for what the harness reported and what it
 * still has live.
 *
 * The panel is a pure function of the contract's own data: it never reads the
 * Model, so `home.ts` only composes it and a test can render a row from a
 * plain fixture. The failure row takes the clock as `now` for the same reason
 * the approval card takes it — a relative label is a function of the client's
 * clock, and the client mints that once.
 */
import type { FailureView, TaskView } from "@mackbot/web-contract";
import type { Html, HtmlBuilder } from "foldkit/html";

import { elapsedOf } from "./format.ts";
import { Message } from "./message.ts";
import { avatar, botName } from "./partials.ts";

/** A failure names its bot: a fault belongs to a bot, not to the fleet. */
const failureRow = (
  bot: string,
  failure: FailureView,
  now: number,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed("div")(
    `${bot}/${failure.kind}/${failure.at}/${failure.name}`,
    [
      h.Class("sp-fail"),
      h.DataAttribute("bot", bot),
      h.DataAttribute("failure", failure.name),
    ],
    [
      avatar(bot, h),
      h.div(
        [h.Class("runit-main")],
        [
          h.span([h.Class("rt")], [failure.name]),
          h.span([h.Class("sp-detail")], [failure.detail]),
          h.span(
            [h.Class("sp-foot")],
            [`reported ${elapsedOf(failure.at, now)} · ${botName(bot)}`],
          ),
        ],
      ),
    ],
  );

/**
 * The harness's own word for a task's state, dressed in the ramp that word
 * means: a task that cannot proceed is a warning, one that is moving is work.
 */
const statusTagOf = (status: TaskView["status"]): string =>
  status === "blocked" || status === "waiting"
    ? "tag warn"
    : status === "pending"
      ? "tag"
      : "tag work";

const taskRow = (bot: string, task: TaskView, h: HtmlBuilder<Message>): Html =>
  h.keyed("div")(
    `${bot}/${task.id}`,
    [
      h.Class("sp-task"),
      h.DataAttribute("bot", bot),
      h.DataAttribute("task", task.id),
      h.DataAttribute("status", task.status),
    ],
    [
      avatar(bot, h),
      h.div(
        [h.Class("runit-main")],
        [
          h.span([h.Class("rt")], [task.kind]),
          ...(task.phase === undefined
            ? []
            : [h.span([h.Class("rmeta")], [task.phase])]),
          h.span([h.Class("sp-foot")], [botName(bot)]),
        ],
      ),
      h.span([h.Class(statusTagOf(task.status))], [task.status]),
    ],
  );

/** The failure rows of one bot, in the order the harness reported them. */
export const failurePanel = (
  bot: string,
  failures: readonly FailureView[],
  now: number,
  h: HtmlBuilder<Message>,
): readonly Html[] => failures.map((failure) => failureRow(bot, failure, now, h));

/**
 * The live task rows of one bot, in the order the harness listed them. A task
 * carries no timestamp of its own, so this panel has no clock to read.
 */
export const taskPanel = (
  bot: string,
  tasks: readonly TaskView[],
  h: HtmlBuilder<Message>,
): readonly Html[] => tasks.map((task) => taskRow(bot, task, h));
