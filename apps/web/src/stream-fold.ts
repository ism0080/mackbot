/**
 * stream-fold — what the events stream does to a channel.
 *
 * Every SSE frame, control event and transport drop lands here as one pure
 * change to one channel, so the subscription stays a transport and the
 * reconnect policy — the cursor, the generation, the retry budget — lives in
 * the Model where a test can read it.
 */
import type { BotView, Frame } from "@mackbot/contract";
import { modifyFields } from "foldkit/struct";

import { mergeEntriesInto, modifyStatus, prunePending } from "./channel.ts";
import { FRAME_WINDOW } from "./model.ts";
import type { Channel, StreamState } from "./model.ts";

const windowFrames = (frames: readonly Frame[], frame: Frame): readonly Frame[] => {
  const next = [...frames, frame];
  return next.length <= FRAME_WINDOW ? next : next.slice(next.length - FRAME_WINDOW);
};

/** A run that ended is no longer a reason to hold the connection. */
const endRun = (view: BotView): BotView => modifyFields(view, { activeRun: () => undefined });

/**
 * The cursor after a frame. A new generation is a new stream counting from its
 * own start, so its first frame reseeds the cursor; within a generation the
 * cursor only moves forward, and a frame that came without an id leaves it be.
 */
const cursorAfter = (stream: StreamState, generation: number, seq: number | undefined): number => {
  if (generation !== stream.generation) return seq ?? 0;
  return seq !== undefined && seq > stream.lastSeq ? seq : stream.lastSeq;
};

/**
 * One Frame, one Channel change. The cursor advances with the frame's `id:`
 * line, while a `snapshot`'s generation is the one thing that reseeds the fold.
 * A frame that arrived is proof the connection works, so it clears the run of
 * failures that sets the reconnect delay.
 */
export const applyFrame = (channel: Channel, frame: Frame, seq: number | undefined): Channel => {
  const generation = frame.kind === "snapshot" ? frame.generation : channel.stream.generation;
  const cursor: Channel = {
    ...channel,
    frames: windowFrames(channel.frames, frame),
    stream: {
      ...channel.stream,
      generation,
      lastSeq: cursorAfter(channel.stream, generation, seq),
      phase: channel.stream.phase === "closed" ? "closed" : "live",
      // A new generation is a new stream, so a previous run's connection count
      // does not carry into it.
      attempt: generation === channel.stream.generation ? channel.stream.attempt : 0,
      failures: 0,
    },
  };

  switch (frame.kind) {
    case "snapshot":
    case "append":
      // A snapshot is the whole window at attachment; an append is what one
      // commit added. Both land in the same place: the transcript's entries,
      // with a locally-sent message retired by the first server copy of it.
      return prunePending(
        { ...cursor, transcript: mergeEntriesInto(cursor.transcript, frame.entries) },
        frame.entries,
      );
    case "run":
      return frame.phase === "end" ? modifyStatus(cursor, endRun) : cursor;
    case "task_failed":
      return modifyStatus(cursor, endRun);
    default:
      // `live`, `inbox` and `usage` change the in-flight tail, which `/status`
      // and the next poll already carry; nothing here needs a second copy.
      return cursor;
  }
};

export const setStreamPhase = (channel: Channel, phase: StreamState["phase"]): Channel => ({
  ...channel,
  stream: { ...channel.stream, phase },
});

/** Drops in a row past this many close the stream: a bot that cannot be
 *  reached falls back to the status poll rather than reconnecting forever. */
export const MAX_STREAM_FAILURES = 5;

/**
 * A dropped transport. `attempt` is the dependency that recreates the
 * connection; `failures` is how many drops have happened with no frame between
 * them, which the subscription turns into a growing wait before it reconnects.
 */
export const reconnect = (channel: Channel): Channel => {
  if (channel.stream.phase === "closed") return channel;
  const failures = channel.stream.failures + 1;
  return {
    ...channel,
    stream: {
      ...channel.stream,
      phase: failures > MAX_STREAM_FAILURES ? "closed" : "retrying",
      attempt: channel.stream.attempt + 1,
      failures,
    },
  };
};

/**
 * The stream the status names. A new generation is a new stream that starts
 * at zero: carrying the previous stream's cursor over would ask it to resume
 * past its own head, and carrying a closed phase over would keep the next run
 * from ever streaming at all. So a rotation starts the descriptor afresh.
 */
export const followStatus = (stream: StreamState, view: BotView | undefined): StreamState => {
  const generation = view?.activeStream?.generation;
  if (generation === undefined || generation === stream.generation) return stream;
  return { phase: "idle", generation, lastSeq: 0, attempt: 0, failures: 0 };
};
