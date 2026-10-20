import { FrameSchema } from "@mackbot/contract";
import type { BotView, Frame } from "@mackbot/contract";
import { Duration, Effect, Equivalence, Option, Queue, Schema, Stream } from "effect";
import { Subscription } from "foldkit";
import { AsyncData } from "foldkit";

import { apiUrl } from "./api.ts";
import { Message } from "./message.ts";
import type { Channel, Model, Screen } from "./model.ts";

/**
 * Ongoing work, expressed as a function of the Model.
 *
 * The screen decides the status poll's lifetime *and* cadence, because both
 * screens read `/status`: a transcript needs it to place the in-flight run, the
 * home for every bot. The dependency record is the schedule's only owner, so a
 * screen change tears the old interval down before the new one opens and two
 * cadences can never run at once.
 *
 * The events stream is the second entry: one SSE connection per bot that is
 * mid-run or blocked on a human, and none for an idle bot. A held connection
 * keeps the Durable Object in memory, so the filter is the cost control.
 */

/** The home folds every bot, so it wants a fresher roster than a transcript. */
const HOME_POLL_MS = 5_000;
const TRANSCRIPT_POLL_MS = 10_000;

const pollMsOf = (screen: Screen): number =>
  screen._tag === "Home" ? HOME_POLL_MS : TRANSCRIPT_POLL_MS;

/** Everything the events entry is a function of, per connection. `lastSeq` is
 *  the resume cursor; `attempt` is the one field a transport drop changes. */
const Source = Schema.Struct({
  bot: Schema.String,
  stream: Schema.String,
  generation: Schema.Number,
  lastSeq: Schema.Number,
  attempt: Schema.Number,
});
type Source = typeof Source.Type;

const statusOf = (channel: Channel | undefined): Option.Option<BotView> =>
  channel === undefined ? Option.none() : AsyncData.getData(channel.status);

const streamIdOf = (channel: Channel | undefined): string =>
  Option.match(statusOf(channel), {
    onNone: () => "",
    onSome: (view) => view.activeStream?.stream ?? "",
  });

/** The two conditions the cost rule names: running, or waiting on a human. */
const holdsWork = (channel: Channel | undefined): boolean =>
  Option.match(statusOf(channel), {
    onNone: () => false,
    onSome: (view) =>
      view.activeRun !== undefined ||
      view.approvals.some((approval) => approval.status === "pending"),
  });

const isLive = (channel: Channel | undefined): boolean =>
  channel !== undefined &&
  channel.stream.phase !== "closed" &&
  streamIdOf(channel) !== "" &&
  holdsWork(channel);

const sourceOf = (bot: string, channel: Channel | undefined): Source => ({
  bot,
  stream: streamIdOf(channel),
  generation: channel?.stream.generation ?? 0,
  lastSeq: channel?.stream.lastSeq ?? 0,
  attempt: channel?.stream.attempt ?? 0,
});

/** The bots to hold open on the current screen, in a stable order so the
 *  dependency equivalence does not see an array reorder as a change. */
const activeSources = (model: Model): readonly Source[] => {
  const bots = model.screen._tag === "Home" ? Object.keys(model.channels) : [model.screen.bot];
  return bots
    .filter((bot) => isLive(model.channels[bot]))
    .map((bot) => sourceOf(bot, model.channels[bot]))
    .sort((left, right) => (left.bot < right.bot ? -1 : left.bot > right.bot ? 1 : 0));
};

const eventsUrl = (source: Source): string => {
  const query = new URLSearchParams({
    stream: source.stream,
    gen: String(source.generation),
    from: String(source.lastSeq),
  });
  return apiUrl(`/events/${encodeURIComponent(source.bot)}?${query.toString()}`);
};

const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(FrameSchema));

/**
 * One bot's connection. `EventSource` is a callback transport with no Effect
 * interface, so it is created and closed inside the stream's own scope, which
 * is what makes the dependency record — not a retry loop — the sole owner of
 * reconnection.
 */
const sourceStream = (source: Source): Stream.Stream<Message> =>
  Stream.callback<Message>((queue) => {
    // Per-connection: a control frame that finishes the stream must not let the
    // transport's own `error` fire a reconnect afterwards.
    const finished = { value: false };
    return Effect.acquireRelease(
      Effect.sync(() => {
        const events = new EventSource(eventsUrl(source));
        events.onmessage = (event) => {
          Option.match(decodeFrame(event.data), {
            onNone: () => undefined,
            onSome: (frame: Frame) =>
              Queue.offerUnsafe(
                queue,
                Message.FrameReceived({
                  bot: source.bot,
                  frame,
                  seq: Number(event.lastEventId),
                  at: Date.now(),
                }),
              ),
          });
        };
        events.addEventListener("up-to-date", () => {
          Queue.offerUnsafe(queue, Message.StreamUpToDate({ bot: source.bot }));
        });
        events.addEventListener("done", () => {
          finished.value = true;
          Queue.offerUnsafe(queue, Message.StreamClosed({ bot: source.bot }));
          events.close();
        });
        events.addEventListener("error", (event) => {
          // The route's `error` control frame is a named SSE event carrying
          // data; the transport's own error is a bare Event.
          if ("data" in event) {
            finished.value = true;
            Queue.offerUnsafe(queue, Message.StreamClosed({ bot: source.bot }));
            events.close();
            return;
          }
          if (!finished.value) {
            Queue.offerUnsafe(queue, Message.StreamDropped({ bot: source.bot }));
          }
        });
        return events;
      }),
      (events) => Effect.sync(() => events.close()),
    ).pipe(Effect.flatMap(() => Effect.never));
  });

const mergeSources = (sources: readonly Source[]): Stream.Stream<Message> =>
  sources.length === 0
    ? Stream.empty
    : Stream.mergeAll(sources.map(sourceStream), { concurrency: "unbounded" });

type EventDependencies = { readonly sources: readonly Source[] };

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
  events: entry(
    { sources: Schema.Array(Source) },
    {
      modelToDependencies: (model: Model): EventDependencies => ({ sources: activeSources(model) }),
      // A frame updates `lastSeq` on every message; reconnecting for each one
      // would be a stream per frame. The cursor therefore stays out of the
      // restart decision while a new attempt — the drop — goes in.
      keepAliveEquivalence: Equivalence.Struct({
        sources: Equivalence.Array(
          Equivalence.Struct({
            bot: Equivalence.String,
            stream: Equivalence.String,
            generation: Equivalence.Number,
            attempt: Equivalence.Number,
          }),
        ),
      }),
      dependenciesToStream: ({ sources }: EventDependencies) => mergeSources(sources),
    },
  ),
}));
