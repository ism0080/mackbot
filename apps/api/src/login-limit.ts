/**
 * login-limit - how often one client may try a token at `/login`.
 *
 * `/login` is the one route that answers without a credential, so it is the
 * one a guesser can hammer. Cloudflare's rate-limiting binding
 * (`LOGIN_RATE_LIMIT`, declared in `alchemy.run.ts` from these numbers) counts
 * every attempt per client - the caller's IP, as Cloudflare reports it - and
 * the Worker refuses an attempt past {@link LOGIN_ATTEMPT_LIMIT} per
 * {@link LOGIN_ATTEMPT_PERIOD_SECONDS} before it looks at the token.
 *
 * The binding counts per Cloudflare location and is eventually consistent, so
 * the limit is a ceiling on guessing speed rather than an exact count. It
 * imports nothing, so the stack definition can read it.
 */

export const LOGIN_ATTEMPT_LIMIT = 5;

/** The binding allows 10 or 60 seconds. */
export const LOGIN_ATTEMPT_PERIOD_SECONDS = 60;

/** Pins the binding's namespace; changing it starts every client's count afresh. */
export const LOGIN_RATE_LIMIT_NAMESPACE = 1001;
