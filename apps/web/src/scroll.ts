/**
 * scroll — the one DOM effect the transcript owns.
 *
 * Scroll position is browser state, so it cannot be derived in the view. Moving
 * to the tail is an effect on an element, which is exactly what a Command is
 * for: the update decides that the person asked for it, and this does it once.
 *
 * The target is the sentinel the transcript ends with rather than the scroller
 * itself, because `scrollIntoView` walks to the nearest scrollable ancestor —
 * so the transcript keeps its own markup as the only thing that knows where its
 * tail is.
 */
import { Effect } from "effect";
import { Command } from "foldkit";
import { scrollIntoViewAfterPaint } from "foldkit/dom";

import { Message } from "./message.ts";

export const ScrollToLatest = Command.define("ScrollToLatest", {
  messages: [Message.ScrolledToLatest],
  execute: scrollIntoViewAfterPaint("#transcript-end").pipe(
    // The screen can change between the click and the paint, and a transcript
    // that is no longer mounted has nothing to scroll: the request is spent
    // either way, so both outcomes land on the same message.
    Effect.as(Message.ScrolledToLatest()),
    Effect.catch(() => Effect.succeed(Message.ScrolledToLatest())),
  ),
});
