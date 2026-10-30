/**
 * session — the browser's half of the front door's credential.
 *
 * The bearer token cannot be shipped to a browser (any served asset is
 * readable) and `EventSource` cannot set an `Authorization` header, so a
 * browser proves the token once at `/login` and carries a signed session
 * cookie after that. The cookie is signed with a key derived from the bearer,
 * never the bearer itself, so the bearer is used as a key for one purpose only:
 * rotating `CHAT_BEARER_TOKEN` invalidates every issued session, and so does
 * bumping {@link SESSION_VERSION}, which is the cheap way to revoke every
 * session without rotating the token.
 */

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { bearerMatches } from "./chat-request.ts";
import { webCrypto } from "./errors.ts";
import type { WebCryptoFailure } from "./errors.ts";

export const SESSION_COOKIE = "mackbot_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export type AuthMethod = "bearer" | "cookie";

/**
 * The session epoch. It is part of both the cookie and the derived key, so a
 * new value rejects every cookie the old one signed.
 */
const SESSION_VERSION = "v2";
const SESSION_KEY_INFO = `mackbot-session-key:${SESSION_VERSION}`;
const SESSION_KEY_SALT = "mackbot-session";
const SESSION_SUBJECT = `mackbot-session:${SESSION_VERSION}`;
const SESSION_VALUE = new RegExp(`^${SESSION_VERSION}\\.(\\d{1,12})\\.([\\w-]{43})$`, "u");
const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

const fromBase64Url = (value: string): Uint8Array =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
    char.charCodeAt(0),
  );

/** The session-signing key, derived from the bearer with HKDF. */
const sessionKey = (token: string): Effect.Effect<CryptoKey, WebCryptoFailure> =>
  webCrypto("deriveKey", async () => {
    const material = await crypto.subtle.importKey("raw", encoder.encode(token), "HKDF", false, [
      "deriveKey",
    ]);
    return await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: encoder.encode(SESSION_KEY_SALT),
        info: encoder.encode(SESSION_KEY_INFO),
      },
      material,
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign", "verify"],
    );
  });

const messageFor = (expires: number): Uint8Array => encoder.encode(`${SESSION_SUBJECT}:${expires}`);

/** A fresh signed session value for `now`, valid for {@link SESSION_MAX_AGE_SECONDS}. */
export const issueSession = Effect.fnUntraced(function* (token: string, now: number) {
  const expires = Math.floor(now / 1000) + SESSION_MAX_AGE_SECONDS;
  const key = yield* sessionKey(token);
  const signature = yield* webCrypto("sign", () =>
    crypto.subtle.sign("HMAC", key, messageFor(expires)),
  );
  return `${SESSION_VERSION}.${expires}.${toBase64Url(new Uint8Array(signature))}`;
});

/** Whether `value` is an unexpired session this token signed. `verify` compares in constant time. */
export const verifySession = (
  token: string,
  value: string,
  now: number,
): Effect.Effect<boolean, WebCryptoFailure> => {
  const match = SESSION_VALUE.exec(value);
  if (match === null) return Effect.succeed(false);
  const expires = Number(match[1]);
  if (expires <= Math.floor(now / 1000)) return Effect.succeed(false);
  const signature = fromBase64Url(match[2]!);
  return sessionKey(token).pipe(
    Effect.flatMap((key) =>
      webCrypto("verify", () => crypto.subtle.verify("HMAC", key, signature, messageFor(expires))),
    ),
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

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * `Secure` everywhere except loopback http, where a `Secure` cookie is silently
 * dropped and the local Worker could never be logged into. A production host
 * over http still gets `Secure`: the login then fails closed rather than
 * downgrading the credential.
 */
const secureAttribute = (url: URL): string =>
  url.protocol === "https:" || !LOOPBACK_HOSTS.has(url.hostname) ? "; Secure" : "";

const cookieWith = (request: Request, value: string, maxAge: number): string =>
  `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureAttribute(new URL(request.url))}`;

export const sessionCookie = (request: Request, value: string): string =>
  cookieWith(request, value, SESSION_MAX_AGE_SECONDS);

/** The `Set-Cookie` value that removes the session cookie: same name, path and attributes. */
export const clearedSessionCookie = (request: Request): string => cookieWith(request, "", 0);

export const authenticate = (
  request: Request,
  token: string,
): Effect.Effect<AuthMethod | undefined, WebCryptoFailure> =>
  Effect.gen(function* () {
    if (yield* bearerMatches(request, token)) return "bearer";
    const cookie = readCookie(request, SESSION_COOKIE);
    if (cookie === undefined) return undefined;
    const now = yield* Clock.currentTimeMillis;
    return (yield* verifySession(token, cookie, now)) ? "cookie" : undefined;
  });

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
