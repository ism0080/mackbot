/**
 * task-retry — running a task the harness parked again.
 *
 * A bot whose every turn crashes is cut off and restarted until the harness
 * parks it as blocked, and a parked task is work the fleet will not pick up
 * on its own. Only a human runs it again, so the retry is a button on the
 * home and a POST to `/retry/:bot`.
 *
 * Pure: the route the retry posts to, the body it posts and the row that
 * offers it. The Command that makes the request lives in `api.ts`, with the
 * app's other Commands.
 */
import type { RetryRequest, TaskView } from "@mackbot/contract";
import * as Schema from "effect/Schema";
import type { Html, HtmlBuilder } from "foldkit/html";

import { Message } from "./message.ts";
import { avatar, botName } from "./partials.ts";
import { button } from "./ui.ts";

/** The harness's own reason for a task it parked instead of running again. */
export const PARKED_REASON = "restart_limit";

/** The part of a task that says the harness parked it. */
const ParkedTaskSchema = Schema.Struct({
  status: Schema.Literal("blocked"),
  reason: Schema.Literal(PARKED_REASON),
});

/** A task the harness parked, and that only a human can run again. */
export const isParked: (task: TaskView) => boolean = Schema.is(ParkedTaskSchema);

/** The route that runs a parked task again. */
export const retryRoute = (bot: string): string => `/retry/${encodeURIComponent(bot)}`;

/** The request that route takes: the task to run again. */
export const retryRequest = (taskId: string): RetryRequest => ({ taskId });

/**
 * One parked task's row: what it was doing, why the harness stopped it, and
 * the button that runs it again.
 */
export const parkedTaskRow = (bot: string, task: TaskView, h: HtmlBuilder<Message>): Html =>
  h.keyed("div")(
    `${bot}/${task.id}`,
    [h.Class("sp-parked"), h.DataAttribute("bot", bot), h.DataAttribute("parked", task.id)],
    [
      avatar(bot, h),
      h.div(
        [h.Class("runit-main")],
        [
          h.span([h.Class("rt")], [task.kind]),
          h.span([h.Class("sp-reason")], [task.reason ?? PARKED_REASON]),
          h.span([h.Class("sp-foot")], [botName(bot)]),
        ],
      ),
      button(
        {
          className: "btn ghost",
          data: [["retry", task.id]],
          onClick: Message.ClickedRetry({ bot, taskId: task.id }),
        },
        ["Retry"],
        h,
      ),
    ],
  );
