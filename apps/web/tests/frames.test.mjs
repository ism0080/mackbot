/*
 * The Frame fold, driven through update directly: a frame changes the channel
 * the routes wrote, so the home and the transcript see it without a refetch.
 * The cursor is the sequence number of the frame's `id:` line, and the control
 * events move the stream's phase.
 *
 * A snapshot is the whole window at attachment; an append is what one commit
 * added. Approvals are not frames: `/status` is where they live.
 */
import { AsyncData } from "foldkit";
import { Option } from "effect";

import { Message } from "../src/message.ts";
import { init, update } from "../src/main.ts";
import { HERMES_STATUS, HERMES_TRANSCRIPT } from "./fixture.mjs";

const apply = (model, message) => update(model, message).model;
const channelOf = (model) => model.channels.hermes;
const dataOf = (asyncData) => Option.getOrUndefined(AsyncData.getData(asyncData));
const report = (label, condition) => console.log(`ok   ${label}: ${condition}`);

const base = () => {
  const started = init().model;
  const seeded = apply(
    started,
    Message.StatusLoaded({ bots: { hermes: HERMES_STATUS }, errors: {}, at: 1 }),
  );
  return apply(seeded, Message.TranscriptLoaded({ bot: "hermes", page: HERMES_TRANSCRIPT }));
};

const snapshot = {
  kind: "snapshot",
  generation: 7,
  at: 10,
  session: "hermes",
  entries: [{ id: 45, kind: "assistant", role: "assistant", text: "New overnight note", at: 10 }],
  live: { tools: [], compactions: [] },
  inbox: [],
  usage: { inputTokens: 0, outputTokens: 0, exchanges: 0 },
  transcriptFrom: 45,
};

const appended = {
  kind: "append",
  at: 11,
  entries: [{ id: 46, kind: "assistant", role: "assistant", text: "Follow-up sent.", at: 11 }],
};

const live = {
  kind: "live",
  at: 12,
  live: {
    generation: { attempt: 1, text: "Working on it" },
    tools: [{ callId: "call-1", name: "botmail.send", status: "running", output: "sending" }],
    compactions: [{ taskId: "9", reason: "manual", blocking: false }],
  },
};

const main = () => {
  let model = base();
  let channel = channelOf(model);

  model = apply(model, Message.FrameReceived({ bot: "hermes", frame: snapshot, seq: 0, at: 10 }));
  channel = channelOf(model);
  report(
    "a snapshot merges its entries into the page",
    dataOf(channel.transcript).entries.some((entry) => entry.id === 45),
  );
  report("the cursor is the frame's sequence number", channel.stream.lastSeq === 0);
  report("the snapshot names the generation", channel.stream.generation === 7);
  report("three frames are in the window", channel.frames.length === 1);

  model = apply(model, Message.FrameReceived({ bot: "hermes", frame: appended, seq: 1, at: 11 }));
  channel = channelOf(model);
  report(
    "an append merges its entries into the page",
    dataOf(channel.transcript).entries.some((entry) => entry.id === 46),
  );
  report("the cursor advances", channel.stream.lastSeq === 1);

  const entriesBefore = dataOf(channelOf(model).transcript).entries.length;
  model = apply(model, Message.FrameReceived({ bot: "hermes", frame: live, seq: 2, at: 12 }));
  channel = channelOf(model);
  report("a live frame advances the cursor", channel.stream.lastSeq === 2);
  report(
    "a live frame does not touch the transcript",
    dataOf(channel.transcript).entries.length === entriesBefore,
  );
  report("three frames are in the window", channel.frames.length === 3);

  model = apply(model, Message.StreamUpToDate({ bot: "hermes" }));
  report("up-to-date marks the stream live", channelOf(model).stream.phase === "live");

  model = apply(model, Message.StreamDropped({ bot: "hermes" }));
  channel = channelOf(model);
  report(
    "a drop becomes a retry attempt",
    channel.stream.phase === "retrying" && channel.stream.attempt === 1,
  );
  report("the cursor survives the drop", channel.stream.lastSeq === 2);

  model = apply(
    model,
    Message.FrameReceived({
      bot: "hermes",
      frame: { kind: "run", phase: "end", at: 13, operationId: "cron:hermes:2026-10-16T09:00" },
      seq: 3,
      at: 13,
    }),
  );
  report(
    "a run-end frame clears the active run",
    dataOf(channelOf(model).status).activeRun === undefined,
  );

  model = apply(model, Message.StreamClosed({ bot: "hermes" }));
  report("a done control event closes the stream", channelOf(model).stream.phase === "closed");
};

main();
process.exit(0);
