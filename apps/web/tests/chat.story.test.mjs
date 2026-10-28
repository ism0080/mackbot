/*
 * The composer's state machine, driven through update directly.
 *
 * Story keeps Commands as data, so these tests assert what the app decided to
 * ask the server for without running a request. The Scene test next door is
 * what proves a person can reach the same behaviour through the view.
 */
import assert from "node:assert/strict";

import { Chat, Status, Transcript } from "../src/api.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { update } from "../src/update.ts";
import { Command as StoryCommand, given, message, model, story } from "foldkit/story";

import { TRANSCRIPTS } from "./fixture.mjs";
import { modelWith, pageWithUser, statusLoaded } from "./support/model.mjs";

const transcriptModel = (channel = {}) => {
  const base = modelWith();
  return {
    ...base,
    screen: Screen.Transcript({ bot: "scribe" }),
    channels: {
      ...base.channels,
      scribe: { ...base.channels.scribe, ...channel },
    },
  };
};

const run = (label, steps) => {
  try {
    steps();
  } catch (cause) {
    console.error(`FAIL ${label}\n${cause?.stack ?? cause}`);
    process.exitCode = 1;
    return;
  }
  console.log(`ok   ${label}`);
};

run("sending trims the draft, shows it at once, and asks the chat route for a receipt", () => {
  story(
    update,
    given(transcriptModel({ draft: "  Write the minutes  " })),
    message(Message.SubmittedChat({ bot: "scribe" })),
    model((next) => {
      assert.equal(next.channels.scribe.draft, "");
      assert.equal(next.channels.scribe.sending, true);
      assert.deepEqual(next.channels.scribe.pending, ["Write the minutes"]);
    }),
    StoryCommand.expectExact(Chat({ bot: "scribe", text: "Write the minutes" })),
    // The receipt path is the next test's subject; this one only proves the
    // Command was emitted with the trimmed text, so it resolves the Command to
    // leave the story with nothing pending.
    StoryCommand.resolve(
      Chat,
      Message.ChatFailed({ bot: "scribe", error: "not sent in this test" }),
    ),
  );
});

run("the receipt refreshes the status and the transcript, and the bubble retires", () => {
  story(
    update,
    given(transcriptModel({ draft: "Write the minutes" })),
    message(Message.SubmittedChat({ bot: "scribe" })),
    StoryCommand.resolve(Chat, Message.ChatSent({ bot: "scribe", operationId: "op_1" })),
    model((next) => {
      assert.equal(next.channels.scribe.sending, false);
    }),
    StoryCommand.expectExact(Status, Transcript({ bot: "scribe" })),
    StoryCommand.resolveAllExact(
      [Status, Message.StatusLoaded(statusLoaded)],
      [
        Transcript({ bot: "scribe" }),
        Message.TranscriptLoaded({
          bot: "scribe",
          page: pageWithUser("Write the minutes"),
          before: undefined,
        }),
      ],
    ),
    model((next) => {
      assert.deepEqual(next.channels.scribe.pending, []);
      assert.ok(
        next.channels.scribe.transcript._tag === "Success" &&
          next.channels.scribe.transcript.data.entries.some(
            (entry) => entry.role === "user" && entry.text === "Write the minutes",
          ),
      );
    }),
  );
});

run("a failed send puts the text back and drops the optimistic bubble", () => {
  story(
    update,
    given(transcriptModel({ draft: "Check the invoices" })),
    message(Message.SubmittedChat({ bot: "scribe" })),
    StoryCommand.resolve(
      Chat,
      Message.ChatFailed({ bot: "scribe", error: "invalid request body" }),
    ),
    model((next) => {
      assert.equal(next.channels.scribe.draft, "Check the invoices");
      assert.deepEqual(next.channels.scribe.pending, []);
      assert.equal(next.channels.scribe.sending, false);
      assert.match(next.toast.text, /invalid request body/u);
    }),
  );
});

run("a submit while one is in flight is ignored", () => {
  story(
    update,
    given(transcriptModel({ draft: "again", sending: true })),
    message(Message.SubmittedChat({ bot: "scribe" })),
    StoryCommand.expectNone(),
    model((next) => {
      assert.equal(next.channels.scribe.draft, "again");
      assert.equal(next.channels.scribe.sending, true);
      assert.deepEqual(next.channels.scribe.pending, []);
    }),
  );
});

run("a new stream generation restarts the cursor instead of resuming past its head", () => {
  const base = modelWith();
  const rotating = { ...base, channels: { ...base.channels } };
  rotating.channels.scribe = {
    ...base.channels.scribe,
    stream: { phase: "closed", generation: 5, lastSeq: 412, attempt: 3 },
  };
  const activeStream = { stream: "feed:scribe:6", generation: 6, cursor: 0, state: "streaming" };

  story(
    update,
    given(rotating),
    message(
      Message.StatusLoaded({
        ...statusLoaded,
        bots: {
          ...statusLoaded.bots,
          scribe: { ...statusLoaded.bots.scribe, activeStream },
        },
      }),
    ),
    model((next) => {
      assert.equal(next.channels.scribe.stream.generation, 6);
      assert.equal(next.channels.scribe.stream.lastSeq, 0);
      assert.equal(next.channels.scribe.stream.attempt, 0);
    }),
  );
});

run("a newest-page reload keeps the older cursor instead of discarding history", () => {
  const page = TRANSCRIPTS.scribe;
  const withCursor = { ...page, nextBefore: page.entries[0].id };
  story(
    update,
    given(transcriptModel({ transcript: { _tag: "Success", data: withCursor } })),
    message(
      Message.TranscriptLoaded({
        bot: "scribe",
        page: pageWithUser("Write the minutes"),
        before: undefined,
      }),
    ),
    model((next) => {
      assert.equal(next.channels.scribe.transcript._tag, "Success");
      const loaded = next.channels.scribe.transcript.data;
      assert.equal(loaded.nextBefore, withCursor.nextBefore);
      assert.deepEqual(
        loaded.entries.map((entry) => entry.id),
        [...page.entries.map((entry) => entry.id), page.entries.at(-1).id + 1],
      );
    }),
  );
});
