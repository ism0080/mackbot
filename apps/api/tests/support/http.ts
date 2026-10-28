/**
 * HTTP helpers for the live integration tests.
 *
 * The tests drive the deployed Worker over its real URL, so everything here is
 * a thin wrapper over `effect/http`: build a request, hand back the response.
 * No route logic is repeated - the tests assert on status codes and wire
 * bodies only.
 */

import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

export type Headers = Readonly<Record<string, string>>;

/** The bearer the Worker was deployed with, from the repo-root `.env`. */
export const token = (): string => {
  const value = process.env.CHAT_BEARER_TOKEN;
  if (value === undefined || value.length === 0) {
    throw new Error("CHAT_BEARER_TOKEN is not set; the test setup loads it from the repo .env");
  }
  return value;
};

/** `Authorization: Bearer <token>`; the scheme case is the caller's choice on purpose. */
export const bearer = (scheme: "Bearer" | "bearer" = "Bearer") => ({
  authorization: `${scheme} ${token()}`,
});

/** A JSON body that carries its own `content-type`. */
export const json = (value: Schema.Json): HttpBody.HttpBody =>
  HttpBody.text(JSON.stringify(value), "application/json");

/** An `application/x-www-form-urlencoded` body, which is what `/login` reads. */
export const form = (value: Readonly<Record<string, string>>): HttpBody.HttpBody =>
  HttpBody.text(new URLSearchParams(value).toString(), "application/x-www-form-urlencoded");

export const get = (
  url: string,
  headers?: Headers,
): Effect.Effect<HttpClientResponse.HttpClientResponse, unknown, HttpClient.HttpClient> =>
  HttpClient.get(url, headers === undefined ? undefined : { headers });

export const post = (
  url: string,
  body?: HttpBody.HttpBody,
  headers?: Headers,
): Effect.Effect<HttpClientResponse.HttpClientResponse, unknown, HttpClient.HttpClient> =>
  HttpClient.post(url, { headers, body });

export const put = (
  url: string,
  body?: HttpBody.HttpBody,
  headers?: Headers,
): Effect.Effect<HttpClientResponse.HttpClientResponse, unknown, HttpClient.HttpClient> =>
  HttpClient.put(url, { headers, body });

export const del = (
  url: string,
  headers?: Headers,
): Effect.Effect<HttpClientResponse.HttpClientResponse, unknown, HttpClient.HttpClient> =>
  HttpClient.del(url, { headers });

/**
 * A request whose redirects stay visible. `fetch` follows redirects by
 * default, which would turn the front door's 302 into the login page's 200 and
 * hide the routing the test is about.
 */
export const manual = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, FetchHttpClient.RequestInit, { redirect: "manual" });

/** The decoded JSON body, typed by the caller. */
export const body = <A = unknown>(
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<A, unknown> =>
  // SAFETY: the caller names the wire shape it requested; the route is the
  // boundary that owns that shape, not this helper.
  Effect.map(response.json, (value) => value as A);

/** The `mackbot_session` cookie a login answered with, when it answered with one. */
export const sessionCookie = (response: HttpClientResponse.HttpClientResponse) =>
  response.cookies.cookies["mackbot_session"];

/** A `Cookie` header carrying only the session the login issued. */
export const cookieHeader = (response: HttpClientResponse.HttpClientResponse) => {
  const cookie = sessionCookie(response);
  if (cookie === undefined) throw new Error("the response issued no mackbot_session cookie");
  return { cookie: `mackbot_session=${cookie.valueEncoded}` };
};
