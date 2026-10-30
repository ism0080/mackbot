import { FrameSchema } from "@mackbot/contract";
import type { Frame } from "@mackbot/contract";
import { Duration, Effect, Equivalence, Option, Queue, Random, Schema, Stream } from "effect";
import { Subscription } from "foldkit";
import { streamFromEvent, streamFromEventFilterMap } from "foldkit/dom";

import { apiUrl } from "./api.ts";
import { conversationStreamOf, pageOf, statusOf } from "./channel.ts";
import { Message } from "./message.ts";
import type { Channel, Model, Screen } from "./model.ts";

/**
 * Ongoing work, expressed as a function of the Model.
 *
 * The screen decides the status poll's lifetime *and* cadence, because both
 * screens read `/status`: a transcript needs it to place the in-flight run, the
 * home for every bot. The dependency record is the schedule's only owner, so a
 * screen change tears the old interval down before the new one opens and two
 * cadences can never run at once. A hidden tab has nobody reading it, so both
 * polls stop until it is shown again.
 *
 * The events stream is the second entry: one SSE connection per bot that is
 * mid-run or blocked on a human, and none for an idle bot. A held connection
 * keeps the Durable Object in memory, so the filter is the cost control.
 */

/** The home folds every bot, so it wants a fresher roster than a transcript. */
const HOME_POLL_MS = 5_000;
const TRANSCRIPT_POLL_MS = 10_000;
/** While a chat is in flight, the open transcript is read more often. */
const CHAT_POLL_MS = 3_000;
/**
 * How long a user message left without an answer keeps the fast poll going. A
 * bot that has not answered in this long is not about to, and the status poll
 * still notices when it starts a run.
 */
export const AWAIT_ANSWER_MS = 2 * 60_000;

/** The first reconnect waits about this long; each drop after it doubles it. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

const pollMsOf = (screen: Screen): number =>
  screen._tag === "Home" ? HOME_POLL_MS : TRANSCRIPT_POLL_MS;

/** Everything the events entry is a function of, per connection. `lastSeq` is
 *  the resume cursor; `attempt` is the one field a transport drop changes, and
 *  `failures` is how long the new connection waits before it opens. */
const Source = Schema.Struct({
  bot: Schema.String,
  stream: Schema.String,
  generation: Schema.Number,
  lastSeq: Schema.Number,
  attempt: Schema.Number,
  failures: Schema.Number,
});
type Source = typeof Source.Type;

/** The stream of the conversation the channel shows, or "" when it has none. */
const streamIdOf = (channel: Channel | undefined): string =>
  conversationStreamOf(channel)?.stream ?? "";

/** The two conditions the cost rule names: running, or waiting on a human. */
const workHeldBy = (channel: Channel | undefined): boolean =>
  Option.match(statusOf(channel), {
    onNone: () => false,
    onSome: (view) =>
      view.activeRun !== undefined ||
      view.approvals.some((approval) => approval.status === "pending"),
  });

/** Whether a bot's stream is worth a connection: it has one, it is not
 *  finished, and the bot is doing something a person would want to see live. */
export const streamWanted = (channel: Channel | undefined): boolean =>
  channel !== undefined &&
  channel.stream.phase !== "closed" &&
  streamIdOf(channel) !== "" &&
  workHeldBy(channel);

/**
 * Whether the newest entry is a user message still waiting for its answer. The
 * status can say idle for a moment after a fast send, and the answer would
 * otherwise wait for a manual reload — but only for a while: past
 * `AWAIT_ANSWER_MS` the wait is over, or a thread that ended on a question
 * nobody answered would poll for as long as it stayed open.
 */
const answerAwaited = (channel: Channel, now: number): boolean =>
  Option.match(pageOf(channel), {
    onNone: () => false,
    onSome: (page) => {
      const last = page.entries[page.entries.length - 1];
      return last?.role === "user" && last.at !== undefined && now - last.at < AWAIT_ANSWER_MS;
    },
  });

/**
 * Whether the open bot has work that can still put entries in its transcript:
 * a send that has not been admitted, a message the transcript has not caught
 * up with, a run the status still calls busy, or a recent user message left
 * without an answer.
 */
export const chatWatching = (channel: Channel | undefined, now: number): boolean =>
  channel !== undefined &&
  (channel.sending ||
    channel.refreshing ||
    channel.pending.length > 0 ||
    answerAwaited(channel, now) ||
    Option.match(statusOf(channel), {
      onNone: () => false,
      onSome: (view) => view.busy || view.activeRun !== undefined,
    }));

const sourceOf = (bot: string, channel: Channel | undefined): Source => ({
  bot,
  stream: streamIdOf(channel),
  generation: channel?.stream.generation ?? 0,
  lastSeq: channel?.stream.lastSeq ?? 0,
  attempt: channel?.stream.attempt ?? 0,
  failures: channel?.stream.failures ?? 0,
});

/** The bots to hold open on the current screen, in a stable order so the
 *  dependency equivalence does not see an array reorder as a change. The
 *  roster screen follows no bot, so it holds no stream open. */
export const activeSources = (model: Model): readonly Source[] => {
  const bots =
    model.screen._tag === "Home"
      ? Object.keys(model.channels)
      : model.screen._tag === "Transcript"
        ? [model.screen.bot]
        : [];
  return bots
    .filter((bot) => streamWanted(model.channels[bot]))
    .map((bot) => sourceOf(bot, model.channels[bot]))
    .sort((left, right) => (left.bot < right.bot ? -1 : left.bot > right.bot ? 1 : 0));
};

/**
 * When two source lists are the same connections. A frame moves `lastSeq` and
 * clears `failures` on every message; reconnecting for either would be a
 * stream per frame. The cursor and the failure count therefore stay out of the
 * restart decision, while a new attempt — the drop — goes in.
 */
export const sourcesEquivalence = Equivalence.Struct({
  sources: Equivalence.Array(
    Equivalence.Struct({
      bot: Equivalence.String,
      stream: Equivalence.String,
      generation: Equivalence.Number,
      attempt: Equivalence.Number,
    }),
  ),
});

const eventsUrl = (source: Source): string => {
  const query = new URLSearchParams({
    stream: source.stream,
    gen: String(source.generation),
    from: String(source.lastSeq),
  });
  return apiUrl(`/events/${encodeURIComponent(source.bot)}?${query.toString()}`);
};

const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(FrameSchema));

const EVENT_ID = /^\d+$/u;

/** The resume cursor an SSE `id:` line names, or none for a frame that came
 *  without one: an absent id is not frame zero. */
export const seqOfEventId = (lastEventId: string): number | undefined =>
  EVENT_ID.test(lastEventId) ? Number(lastEventId) : undefined;

/**
 * How long a connection waits before it opens: nothing for the first, then a
 * doubling wait per drop in a row, capped, with jitter so a fleet of tabs that
 * lost the Worker together does not come back in lockstep.
 */
const reconnectDelay = (failures: number): Effect.Effect<Duration.Duration> =>
  failures === 0
    ? Effect.succeed(Duration.zero)
    : Effect.map(Random.nextBetween(0.5, 1), (jitter) =>
        Duration.millis(
          Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (failures - 1)) * jitter,
        ),
      );

/**
 * One bot's connection. `EventSource` is a callback transport with no Effect
 * interface, so it is created and closed inside the stream's own scope, which
 * is what makes the dependency record — not a retry loop — the sole owner of
 * reconnection. A reconnect waits out its delay inside the same scope, so a
 * screen change during the wait cancels it.
 */
const sourceStream = (source: Source): Stream.Stream<Message> =>
  Stream.callback<Message>((queue) => {
    // Per-connection: a control frame that finishes the stream must not let the
    // transport's own `error` fire a reconnect afterwards.
    const finished = { value: false };
    return reconnectDelay(source.failures).pipe(
      Effect.flatMap(Effect.sleep),
      Effect.andThen(
        Effect.acquireRelease(
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
                      stream: source.stream,
                      frame,
                      seq: seqOfEventId(event.lastEventId),
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
                finished.value = true;
                // The dependency record owns the retry, so the browser's own
                // reconnect loop is stopped before it starts a second one.
                events.close();
                Queue.offerUnsafe(queue, Message.StreamDropped({ bot: source.bot }));
              }
            });
            return events;
          }),
          (events) => Effect.sync(() => events.close()),
        ),
      ),
      Effect.flatMap(() => Effect.never),
    );
  });

const mergeSources = (sources: readonly Source[]): Stream.Stream<Message> =>
  sources.length === 0
    ? Stream.empty
    : Stream.mergeAll(sources.map(sourceStream), { concurrency: "unbounded" });

type EventDependencies = { readonly sources: readonly Source[] };

/**
 * How close to the tail still counts as "at the tail". A row's height, so a
 * paragraph that lands while the person is reading the last entry does not
 * offer to take them to where they already are.
 */
const TAIL_SLACK_PX = 32;

/** The scroller the transcript renders, named so the listener can find it. */
const SCROLLER_ID = "transcript-scroll";

const pollTicks = <A>(everyMs: number, message: () => A): Stream.Stream<A> =>
  Stream.tick(Duration.millis(everyMs)).pipe(
    // The scope's first tick is the interval's start, not a second immediate
    // fetch: whatever opened the interval already asked once.
    Stream.drop(1),
    Stream.map(message),
  );

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  statusPoll: entry(
    { everyMs: Schema.Number, visible: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ everyMs: pollMsOf(model.screen), visible: model.visible }),
      dependenciesToStream: ({ everyMs, visible }) =>
        visible ? pollTicks(everyMs, () => Message.PolledStatus()) : Stream.empty,
    },
  ),
  transcriptPoll: entry(
    { bot: Schema.String, watching: Schema.Boolean },
    {
      modelToDependencies: (model) =>
        model.screen._tag === "Transcript" && model.visible
          ? {
              bot: model.screen.bot,
              watching: chatWatching(model.channels[model.screen.bot], model.now),
            }
          : { bot: "", watching: false },
      // The poll's own result changes `refreshing` and `pending`; restarting on
      // those would reset the interval. Only entering or leaving the watched
      // window is a dependency change.
      keepAliveEquivalence: Equivalence.Struct({
        bot: Equivalence.String,
        watching: Equivalence.Boolean,
      }),
      dependenciesToStream: ({
        bot,
        watching,
      }: {
        readonly bot: string;
        readonly watching: boolean;
      }) =>
        watching ? pollTicks(CHAT_POLL_MS, () => Message.PolledTranscript({ bot })) : Stream.empty,
    },
  ),
  visibility: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        streamFromEvent({
          target: document,
          type: "visibilitychange",
          mapEvent: () =>
            Message.ChangedVisibility({ visible: document.visibilityState === "visible" }),
        }),
    },
  ),
  transcriptScroll: entry(
    { active: Schema.Boolean },
    {
      modelToDependencies: (model: Model) => ({ active: model.screen._tag === "Transcript" }),
      // `scroll` does not bubble, but it does reach a capturing listener on the
      // document. Listening there and picking out the transcript's scroller
      // follows whichever element the screen rendered, with no window in which
      // the listener could have attached to something else.
      dependenciesToStream: ({ active }) =>
        active
          ? streamFromEventFilterMap({
              target: document,
              type: "scroll",
              options: { capture: true, passive: true },
              filterMapEvent: (event) => {
                const element = event.target;
                if (!(element instanceof HTMLElement) || element.id !== SCROLLER_ID) {
                  return Option.none();
                }
                const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
                return Option.some(
                  Message.ScrolledTranscript({ atBottom: remaining <= TAIL_SLACK_PX }),
                );
              },
            })
          : Stream.empty,
    },
  ),
  events: entry(
    { sources: Schema.Array(Source) },
    {
      modelToDependencies: (model: Model): EventDependencies => ({ sources: activeSources(model) }),
      keepAliveEquivalence: sourcesEquivalence,
      dependenciesToStream: ({ sources }: EventDependencies) => mergeSources(sources),
    },
  ),
}));
