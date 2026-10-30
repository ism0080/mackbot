/**
 * errors — how a caught cause is put into a log line.
 *
 * Every Effect boundary in the Worker catches `unknown`, and every one of them
 * logs it the same way, so the wording lives here once.
 */

import * as Effect from "effect/Effect";

/**
 * The message of an error, or the value itself when it is not one. `String()`
 * throws for a value with a null prototype, and a log line about a failure
 * must not fail while it formats the failure.
 */
export const describeCause = (cause: unknown): string =>
  cause instanceof Error
    ? cause.message
    : Effect.runSync(
        Effect.try(() => String(cause)).pipe(
          Effect.orElseSucceed(() => Object.prototype.toString.call(cause)),
        ),
      );
