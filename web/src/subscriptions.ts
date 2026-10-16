import { Duration, Schema, Stream } from "effect";
import { Subscription } from "foldkit";

import { Message } from "./message.ts";
import type { Model, Screen } from "./model.ts";

/**
 * Ongoing work, expressed as a function of the Model.
 *
 * The screen decides the poll's lifetime *and* its cadence, because both
 * screens read `/status`: the transcript needs it to place the in-flight run,
 * and the home needs it for every bot. The dependency record is the schedule's
 * only owner, so a screen change tears the old interval down before the new one
 * opens and two cadences can never run at once.
 */

/** The home folds every bot, so it wants a fresher roster than a transcript. */
const HOME_POLL_MS = 5_000;
const TRANSCRIPT_POLL_MS = 10_000;

const pollMsOf = (screen: Screen): number =>
  screen._tag === "Home" ? HOME_POLL_MS : TRANSCRIPT_POLL_MS;

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  statusPoll: entry(
    { everyMs: Schema.Number },
    {
      modelToDependencies: (model) => ({ everyMs: pollMsOf(model.screen) }),
      dependenciesToStream: ({ everyMs }) =>
        Stream.tick(Duration.millis(everyMs)).pipe(
          // The scope's first tick is the interval's start, not a second
          // immediate fetch: `init` already dispatched one.
          Stream.drop(1),
          Stream.map(() => Message.PolledStatus()),
        ),
    },
  ),
}));
