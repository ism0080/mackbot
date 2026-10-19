/**
 * session — the browser's half of the front door's credential.
 *
 * The bearer token cannot be shipped to a browser (any served asset is
 * readable) and `EventSource` cannot set an `Authorization` header, so a
 * browser proves the token once at `/login` and carries a signed session
 * cookie after that. The cookie is derived from the bearer, not a copy of it:
 * rotating `CHAT_BEARER_TOKEN` invalidates every issued session.
 */

import * as Effect from "effect/Effect";

import { isAuthorized, tokensMatch } from "./chat-request.ts";

export const SESSION_COOKIE = "mackbot_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export type AuthMethod = "bearer" | "cookie";

const SESSION_VERSION = "v1";
const SESSION_SUBJECT = "mackbot-session:v1";
const SESSION_VALUE = /^v1\.(\d{1,12})\.([\w-]{43})$/u;
const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

const sign = (token: string, message: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(token),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
    return toBase64Url(new Uint8Array(signature));
  });

const messageFor = (expires: number): string => `${SESSION_SUBJECT}:${expires}`;

/** A fresh signed session value for `now`, valid for {@link SESSION_MAX_AGE_SECONDS}. */
export const issueSession = (token: string, now: number): Effect.Effect<string> =>
  Effect.gen(function* () {
    const expires = Math.floor(now / 1000) + SESSION_MAX_AGE_SECONDS;
    const signature = yield* sign(token, messageFor(expires));
    return `${SESSION_VERSION}.${expires}.${signature}`;
  });

export const verifySession = (token: string, value: string, now: number): Effect.Effect<boolean> => {
  const match = SESSION_VALUE.exec(value);
  if (match === null) return Effect.succeed(false);
  const expires = Number(match[1]);
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(now / 1000)) {
    return Effect.succeed(false);
  }
  const presented = match[2]!;
  return sign(token, messageFor(expires)).pipe(
    Effect.map((expected) => tokensMatch(presented, expected)),
  );
};

export const readCookie = (request: Request, name: string): string | undefined => {
  const header = request.headers.get("Cookie");
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
};

/**
 * `Secure` everywhere except loopback http, where a `Secure` cookie is silently
 * dropped and the local Worker could never be logged into. A production host
 * over http still gets `Secure`: the login then fails closed rather than
 * downgrading the credential.
 */
const isLoopback = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "[::1]" ||
  hostname === "::1";

const secureAttribute = (url: URL): string =>
  url.protocol === "https:" || !isLoopback(url.hostname) ? "; Secure" : "";

export const sessionCookie = (request: Request, value: string): string =>
  `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secureAttribute(new URL(request.url))}`;

export const authenticate = (
  request: Request,
  token: string,
): Effect.Effect<AuthMethod | undefined> => {
  if (isAuthorized(request, token)) return Effect.succeed("bearer");
  const cookie = readCookie(request, SESSION_COOKIE);
  if (cookie === undefined) return Effect.succeed(undefined);
  return verifySession(token, cookie, Date.now()).pipe(
    Effect.map((valid): AuthMethod | undefined => (valid ? "cookie" : undefined)),
  );
};

/**
 * A cookie-authenticated mutation must also prove it came from this origin:
 * `Origin` must match and the caller must set `X-Mackbot-CSRF`. A cross-site
 * form cannot set that header, and a cross-site fetch that does triggers a
 * preflight this Worker never answers. Bearer requests need neither check — a
 * cross-site page cannot attach an `Authorization` header in the first place.
 */
export const csrfAllows = (request: Request): boolean =>
  request.headers.get("X-Mackbot-CSRF") === "1" &&
  request.headers.get("Origin") === new URL(request.url).origin;
