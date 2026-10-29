/**
 * steps — what a running bot is doing, and what it has already done.
 *
 * The harness publishes the current tool round on `pi.live`, and the feed
 * carries it on every `live` and `snapshot` frame. That is the only place the
 * *shape* of a run exists: `/status` knows a run is active and the transcript
 * only learns about a tool once it has committed, so a rail built from entries
 * would show the steps of the last turn rather than of the run in hand.
 *
 * The rail is deliberately the harness's own vocabulary — `commitments.read`,
 * not "reading your commitments". The client cannot invent a friendly name for
 * a tool it has never seen, and a rail that guessed would be worse than one
 * that is accurate.
 */
import type { LiveToolView } from "@mackbot/contract";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Message } from "./message.ts";
import type { Channel } from "./model.ts";

/** The tool round of the run in flight, as the newest live frame reported it. */
export const stepsOf = (channel: Channel | undefined): readonly LiveToolView[] => {
  if (channel === undefined) return [];
  for (let index = channel.frames.length - 1; index >= 0; index -= 1) {
    const frame = channel.frames[index];
    if (frame !== undefined && (frame.kind === "live" || frame.kind === "snapshot")) {
      return frame.live.tools;
    }
  }
  return [];
};

/**
 * The step a person is waiting on: the tool the harness is running right now.
 * A round between tools has none, and the caller falls back to the run's own
 * words rather than inventing a step.
 */
export const stepNow = (steps: readonly LiveToolView[]): string | undefined =>
  steps.find((step) => step.status === "running")?.name;

/**
 * The rail, oldest step first. `running` is the one that gets the accent: an
 * operator glancing at triage needs the current step to be the loudest thing
 * in the list, not the first one.
 */
export const stepsRail = (steps: readonly LiveToolView[], h: HtmlBuilder<Message>): Html =>
  h.ul(
    [h.Class("steps-list")],
    steps.map((step, index) =>
      h.keyed("li")(
        `${step.callId}:${index}`,
        [
          h.Class(step.status === "done" ? "done" : step.status === "running" ? "now" : "waiting"),
          h.DataAttribute("step", step.name),
        ],
        [h.span([h.Class("nm")], [step.name])],
      ),
    ),
  );
