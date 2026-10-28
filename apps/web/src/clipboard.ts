/**
 * clipboard — taking one message out of the transcript.
 *
 * A bot's reply is often wanted somewhere else: pasted into a draft, a note, or
 * the thread it is about. The text is copied as it was written, markdown
 * markers and all, so it pastes into an editor the way the bot composed it.
 *
 * The clipboard is a browser side effect, so it is a Command. A refusal is the
 * ordinary case on an insecure origin or when the browser withholds the
 * permission, so the failure is a Message the app can report rather than an
 * exception nobody sees.
 */

import { Effect } from "effect";
import * as Schema from "effect/Schema";
import { Command } from "foldkit";

import { Message } from "./message.ts";

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const CopyMessage = Command.define("CopyMessage", {
  args: { text: Schema.String },
  messages: [Message.CopiedMessage, Message.CopyFailed],
  execute: ({ text }) =>
    Effect.tryPromise({
      try: () => navigator.clipboard.writeText(text),
      catch: (cause) => cause,
    }).pipe(
      Effect.as(Message.CopiedMessage()),
      Effect.catch((cause) => Effect.succeed(Message.CopyFailed({ error: describe(cause) }))),
    ),
});
