/**
 * clock - the wall clock for the Worker's synchronous code.
 *
 * The SQLite stores and the pi callbacks run synchronously or as plain
 * promises, outside any Effect runtime, so they cannot yield `Clock`. They
 * read it here instead, through Effect's own Clock, so there is one place the
 * Worker's modules take the time from.
 */

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

/** Milliseconds since the epoch, as Effect's Clock reports them. */
export const currentTimeMillis = (): number => Effect.runSync(Clock.currentTimeMillis);
