/**
 * auth - the two routes that change who the browser is: `/login` and `/logout`.
 *
 * `/login` answers without a credential, so it is throttled per client by a
 * {@link LoginGuard}: the Worker passes the `Bot` Durable Object instance
 * named {@link LOGIN_GUARD_NAME}, whose SQLite holds the counts (see
 * `login-throttle.ts`). The guard is checked before the token is, so a client
 * that is locked out learns nothing from another guess.
 */

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { tokensMatch } from "./chat-request.ts";
import { jsonError, methodNotAllowed, secured } from "./http.ts";
import { LOGIN_CONTENT_SECURITY_POLICY, loginDocument } from "./login-page.ts";
import type { LoginNotice } from "./login-page.ts";
import { clearedSessionCookie, csrfAllows, issueSession, sessionCookie } from "./session.ts";

/** The failed-login counts, as the front door reaches them. */
export interface LoginGuard {
  /** Seconds until `client` may try again, or `undefined` when it may try now. */
  loginRetryAfter(client: string): Promise<number | undefined>;
  recordLoginFailure(client: string): Promise<void>;
  clearLoginFailures(client: string): Promise<void>;
}

/**
 * The `Bot` instance that holds the login counts. A bot id must start with a
 * lowercase letter or digit, so no declared bot can ever share this name.
 */
export const LOGIN_GUARD_NAME = "_login-guard";

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
  guard: LoginGuard,
): Promise<Response> => {
  if (request.method === "GET") return loginPage("none", 200);
  if (request.method !== "POST") return methodNotAllowed();
  const client = clientOf(request);
  const retryAfter = await guard.loginRetryAfter(client);
  if (retryAfter !== undefined) {
    return loginPage("throttled", 429, { "Retry-After": String(retryAfter) });
  }
  const accepted = await Effect.runPromise(
    readLoginToken(request).pipe(
      Effect.flatMap((presented) =>
        presented === undefined ? Effect.succeed(false) : tokensMatch(presented, token),
      ),
    ),
  );
  if (!accepted) {
    await guard.recordLoginFailure(client);
    return loginPage("rejected", 401);
  }
  await guard.clearLoginFailures(client);
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
