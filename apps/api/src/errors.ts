/**
 * errors - how a caught cause is put into a log line, and the failures the
 * Worker's platform calls are typed as.
 *
 * Every Effect boundary in the Worker catches `unknown`, and every one of them
 * logs it the same way, so the wording lives here once.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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

/** A WebCrypto call rejected: a key could not be derived, or a digest or signature not made. */
export class WebCryptoFailure extends Schema.TaggedError<WebCryptoFailure>()("WebCryptoFailure", {
  /** The WebCrypto operation that rejected. */
  operation: Schema.String,
  message: Schema.String,
}) {}

/** One WebCrypto call, its rejection a {@link WebCryptoFailure} naming the operation. */
export const webCrypto = <A>(
  operation: string,
  call: () => Promise<A>,
): Effect.Effect<A, WebCryptoFailure> =>
  Effect.tryPromise({
    try: call,
    catch: (cause) => new WebCryptoFailure({ operation, message: describeCause(cause) }),
  });
