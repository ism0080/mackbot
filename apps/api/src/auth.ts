/**
 * auth - the two routes that change who the browser is: `/login` and `/logout`.
 *
 * `/login` answers without a credential, so every attempt first spends one of
 * the client's allowance on the `LOGIN_RATE_LIMIT` binding (see
 * `login-limit.ts`). The limit is checked before the token is, so a client
 * past it learns nothing from another guess; and a limiter that cannot answer
 * refuses the attempt rather than letting it through uncounted.
 */

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { tokensMatch } from "./chat-request.ts";
import { jsonError, methodNotAllowed, secured } from "./http.ts";
import { LOGIN_ATTEMPT_PERIOD_SECONDS } from "./login-limit.ts";
import { LOGIN_CONTENT_SECURITY_POLICY, loginDocument } from "./login-page.ts";
import type { LoginNotice } from "./login-page.ts";
import { clearedSessionCookie, csrfAllows, issueSession, sessionCookie } from "./session.ts";

/** The part of Cloudflare's rate-limiting binding `/login` uses. */
export type LoginLimiter = Pick<RateLimit, "limit">;

const LoginFormSchema = Schema.Struct({ token: Schema.NonEmptyString });

const readLoginToken = (request: Request): Effect.Effect<string | undefined> =>
  Effect.tryPromise(() => request.formData()).pipe(
    Effect.map((form) => Object.fromEntries(form)),
    Effect.flatMap(Schema.decodeUnknownEffect(LoginFormSchema)),
    Effect.map((body): string | undefined => body.token),
    Effect.orElseSucceed(() => undefined),
  );

/** Who is guessing: the caller's address as Cloudflare saw it. */
const clientOf = (request: Request): string => request.headers.get("CF-Connecting-IP") ?? "unknown";

/** Whether `client` may try a token now; spends one attempt of its allowance. */
const attemptAllowed = (limiter: LoginLimiter, client: string): Effect.Effect<boolean> =>
  Effect.tryPromise(() => limiter.limit({ key: client })).pipe(
    Effect.map((outcome) => outcome.success),
    Effect.tapError((cause) => Effect.logError("login rate limiter failed", cause)),
    Effect.orElseSucceed(() => false),
  );

const loginPage = (notice: LoginNotice, status: number, headers: Record<string, string> = {}) =>
  secured(
    new Response(loginDocument(notice), {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        ...headers,
      },
    }),
    LOGIN_CONTENT_SECURITY_POLICY,
  );

export const handleLogin = async (
  request: Request,
  token: string,
  limiter: LoginLimiter,
): Promise<Response> => {
  if (request.method === "GET") return loginPage("none", 200);
  if (request.method !== "POST") return methodNotAllowed();
  if (!(await Effect.runPromise(attemptAllowed(limiter, clientOf(request))))) {
    return loginPage("throttled", 429, { "Retry-After": String(LOGIN_ATTEMPT_PERIOD_SECONDS) });
  }
  const accepted = await Effect.runPromise(
    readLoginToken(request).pipe(
      Effect.flatMap((presented) =>
        presented === undefined ? Effect.succeed(false) : tokensMatch(presented, token),
      ),
    ),
  );
  if (!accepted) return loginPage("rejected", 401);
  const value = await Effect.runPromise(
    Effect.flatMap(Clock.currentTimeMillis, (now) => issueSession(token, now)),
  );
  return secured(
    new Response(null, {
      status: 303,
      headers: {
        Location: "/",
        "Set-Cookie": sessionCookie(request, value),
        "cache-control": "no-store",
      },
    }),
    LOGIN_CONTENT_SECURITY_POLICY,
  );
};

/**
 * Sign the browser out by removing its session cookie.
 *
 * It needs no credential, since a client without a session has nothing to
 * lose, but it is a mutation, so it carries the same origin proof every other
 * cookie mutation does: a cross-site page cannot sign the user out.
 */
export const handleLogout = (request: Request): Response => {
  if (request.method !== "POST") return methodNotAllowed();
  if (!csrfAllows(request)) return jsonError(403, "forbidden");
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": clearedSessionCookie(request), "cache-control": "no-store" },
  });
};
