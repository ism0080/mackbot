/**
 * chat-request — the HTTP front door's request contract.
 *
 * This module owns bearer authorization and body decoding for `POST /chat/:bot`:
 * `bearerMatches` checks the `Authorization: Bearer <token>` header against the
 * configured token, and `readChatRequest` turns the request body into a
 * validated {@link ChatRequest}. Both are pure logic testable against a real
 * `Request` without a live Durable Object or the Workers runtime.
 *
 * `tokensMatch` is exported for the login form, so every comparison against
 * the bearer is constant-time and leaks neither content nor length.
 */

import type { PiWhenBusy } from "agents/harness/pi";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { trimmedNonEmpty } from "@mackbot/contract";

import { webCrypto } from "./errors.ts";
import type { WebCryptoFailure } from "./errors.ts";
import { readJsonBody } from "./http.ts";

export { MAX_BODY_BYTES } from "./http.ts";

export interface ChatRequest {
  readonly text: string;
  readonly operationId?: string;
  readonly whenBusy?: PiWhenBusy;
  readonly wait?: boolean;
  readonly thread?: string;
}

export const MAX_TEXT_LENGTH = 16_384;

const boundedText = Schema.String.check(
  Schema.makeFilter((input: string) => input.trim().length > 0 && input.length <= MAX_TEXT_LENGTH),
);

const ChatRequestBodySchema = Schema.Struct({
  text: boundedText,
  operationId: Schema.optional(Schema.NonEmptyString),
  whenBusy: Schema.optional(Schema.Literals(["followUp", "steer"])),
  wait: Schema.optional(Schema.Boolean),
  thread: Schema.optional(trimmedNonEmpty),
});

const BEARER_PATTERN = /^Bearer\s+(.+)$/iu;
const encoder = new TextEncoder();

const digest = (value: string): Effect.Effect<ArrayBuffer, WebCryptoFailure> =>
  webCrypto("digest", () => crypto.subtle.digest("SHA-256", encoder.encode(value)));

/**
 * Compare two equal-length digests in constant time. Workers provide
 * `timingSafeEqual`; the loop is the same comparison where it is missing (the
 * unit tests run on Node), and it is constant-time because both inputs are
 * always 32 bytes.
 */
const digestsEqual = (a: ArrayBuffer, b: ArrayBuffer): boolean => {
  if (Predicate.isFunction(crypto.subtle.timingSafeEqual)) {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index]! ^ right[index]!;
  }
  return diff === 0;
};

/**
 * Whether `presented` is `expected`. Both are hashed first, so the comparison
 * always runs over 32 bytes and takes the same time whatever either length is.
 */
export const tokensMatch = (
  presented: string,
  expected: string,
): Effect.Effect<boolean, WebCryptoFailure> =>
  Effect.all([digest(presented), digest(expected)]).pipe(
    Effect.map(([a, b]) => digestsEqual(a, b)),
  );

export const bearerMatches = (
  request: Request,
  expected: string,
): Effect.Effect<boolean, WebCryptoFailure> => {
  const header = request.headers.get("Authorization");
  const token = header === null ? undefined : BEARER_PATTERN.exec(header)?.[1];
  return token === undefined ? Effect.succeed(false) : tokensMatch(token, expected);
};

export const readChatRequest = (request: Request): Promise<ChatRequest | undefined> =>
  readJsonBody(request, ChatRequestBodySchema);
