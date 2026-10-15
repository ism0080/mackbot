/**
 * chat-request — the HTTP front door's request contract.
 *
 * This module owns bearer authorization and body decoding for `POST /chat/:bot`:
 * `isAuthorized` checks the `Authorization: Bearer <token>` header against the
 * configured token, and `readChatRequest` turns the request body into a
 * validated {@link ChatRequest}. Extracted from `src/index.ts` so both are pure
 * logic testable against a real `Request` without a live Durable Object or the
 * Workers runtime, mirroring `src/bot-delegation.ts`'s shape (header doc,
 * exported guards, Schema-based validation).
 *
 * Public API (what `src/index.ts` imports):
 *
 *   import { isAuthorized, readChatRequest } from "./chat-request.ts";
 *   if (!isAuthorized(request, env.CHAT_BEARER_TOKEN)) { ... 401 ... }
 *   const body = await readChatRequest(request);
 */

import type { PiWhenBusy } from "agents/harness/pi";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface ChatRequest {
  readonly text: string;
  readonly operationId?: string;
  readonly whenBusy?: PiWhenBusy;
  readonly wait?: boolean;
  readonly thread?: string;
}

export const MAX_TEXT_LENGTH = 16_384;
export const MAX_BODY_BYTES = 256 * 1024;

const trimmedNonEmpty = Schema.String.check(
  Schema.makeFilter((input: string) => input.trim().length > 0),
);

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

const tokensMatch = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
};

export const isAuthorized = (request: Request, expected: string): boolean => {
  const header = request.headers.get("Authorization");
  if (header === null) return false;
  const token = BEARER_PATTERN.exec(header)?.[1];
  return token !== undefined && tokensMatch(token, expected);
};

/**
 * Read at most `maxBytes` of the request body. The cap is enforced against the
 * stream, not only `content-length`, so a chunked request cannot bypass it.
 */
const readBoundedBody = async (request: Request, maxBytes: number): Promise<string | undefined> => {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBytes) return undefined;
  const body = request.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(result.value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
};

export const readChatRequest = async (request: Request): Promise<ChatRequest | undefined> => {
  const rawText = await readBoundedBody(request, MAX_BODY_BYTES);
  if (rawText === undefined) return undefined;
  const effect = Schema.decodeUnknownEffect(Schema.fromJsonString(ChatRequestBodySchema))(
    rawText,
  ).pipe(Effect.mapError(() => "bad body" as const));
  return Effect.runPromise(effect.pipe(Effect.orElseSucceed(() => undefined)));
};
