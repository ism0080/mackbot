import * as Effect from "effect/Effect";
import { describe, expect, test } from "vitest";

import {
  bearerMatches,
  MAX_BODY_BYTES,
  MAX_TEXT_LENGTH,
  readChatRequest,
  tokensMatch,
} from "../src/chat-request.ts";

const CHAT_URL = "https://mackbot.test/chat/hermes";
const TOKEN = "correct-horse-battery-staple";

const matches = (presented: string, expected: string): Promise<boolean> =>
  Effect.runPromise(tokensMatch(presented, expected));

const authorized = (request: Request, expected: string): Promise<boolean> =>
  Effect.runPromise(bearerMatches(request, expected));

const withAuth = (header: string | undefined): Request =>
  new Request(CHAT_URL, {
    method: "POST",
    headers: header === undefined ? {} : { Authorization: header },
  });

const jsonRequest = (body: string, headers: Record<string, string> = {}): Request =>
  new Request(CHAT_URL, { method: "POST", body, headers });

/** A chunked body: no `content-length`, and sized however the caller asks. */
const streamedRequest = (text: string, chunkSize = 1024): Request => {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
  // Node's fetch needs `duplex` to accept a streaming request body, but the
  // DOM lib's `RequestInit` does not declare it.
  const init = { method: "POST", body, duplex: "half" };
  // SAFETY: `duplex: "half"` is the Node fetch extension this request needs.
  return new Request(CHAT_URL, init as RequestInit);
};

const paddedJson = (padding: number): string => `{"text":"hello"${" ".repeat(padding)}}`;

describe("tokensMatch", () => {
  test("is true for equal strings", async () => {
    expect(await matches(TOKEN, TOKEN)).toBe(true);
    expect(await matches("", "")).toBe(true);
  });

  test("is false for strings of different lengths", async () => {
    expect(await matches("short", "longer")).toBe(false);
    expect(await matches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(await matches("", TOKEN)).toBe(false);
  });

  test("is false when a single character differs", async () => {
    const flipped = `${TOKEN.slice(0, 10)}X${TOKEN.slice(11)}`;
    expect(flipped).not.toBe(TOKEN);
    expect(await matches(flipped, TOKEN)).toBe(false);
  });
});

describe("bearerMatches", () => {
  test.each([
    ["Bearer", `Bearer ${TOKEN}`],
    ["lowercase scheme", `bearer ${TOKEN}`],
    ["mixed-case scheme", `BeArEr ${TOKEN}`],
    ["extra spaces after the scheme", `Bearer    ${TOKEN}`],
  ])("accepts %s", async (_label, header) => {
    expect(await authorized(withAuth(header), TOKEN)).toBe(true);
  });

  test("rejects a wrong token of the same length", async () => {
    const sameLength = `${TOKEN.slice(0, -1)}!`;
    expect(sameLength).toHaveLength(TOKEN.length);
    expect(await authorized(withAuth(`Bearer ${sameLength}`), TOKEN)).toBe(false);
  });

  test("rejects a token that is a prefix of the expected token", async () => {
    expect(await authorized(withAuth(`Bearer ${TOKEN.slice(0, -1)}`), TOKEN)).toBe(false);
  });

  test("rejects a token that is a suffix of the expected token", async () => {
    expect(await authorized(withAuth(`Bearer ${TOKEN.slice(1)}`), TOKEN)).toBe(false);
  });

  test("rejects a token with a trailing character appended", async () => {
    expect(await authorized(withAuth(`Bearer ${TOKEN}x`), TOKEN)).toBe(false);
  });

  test("rejects a missing Authorization header", async () => {
    expect(await authorized(withAuth(undefined), TOKEN)).toBe(false);
  });

  test("rejects a non-Bearer scheme", async () => {
    expect(await authorized(withAuth(`Basic ${TOKEN}`), TOKEN)).toBe(false);
    expect(await authorized(withAuth(`Token ${TOKEN}`), TOKEN)).toBe(false);
  });

  test("rejects a bare token without the scheme", async () => {
    expect(await authorized(withAuth(TOKEN), TOKEN)).toBe(false);
  });
});

describe("readChatRequest", () => {
  test("decodes a minimal body without inventing extra fields", async () => {
    const decoded = await readChatRequest(jsonRequest('{"text":"hello"}'));
    expect(decoded).toEqual({ text: "hello" });
  });

  test("preserves operationId, whenBusy, wait and thread when present", async () => {
    const decoded = await readChatRequest(
      jsonRequest(
        '{"text":"hello","operationId":"http:abc","whenBusy":"steer","wait":true,"thread":"t-1"}',
      ),
    );
    expect(decoded).toEqual({
      text: "hello",
      operationId: "http:abc",
      whenBusy: "steer",
      wait: true,
      thread: "t-1",
    });
  });

  test.each([
    ["empty text", '{"text":""}'],
    ["whitespace text", '{"text":"   \\n\\t "}'],
  ])("rejects %s", async (_label, body) => {
    expect(await readChatRequest(jsonRequest(body))).toBeUndefined();
  });

  test("accepts text of exactly MAX_TEXT_LENGTH characters", async () => {
    const text = "a".repeat(MAX_TEXT_LENGTH);
    expect(await readChatRequest(jsonRequest(JSON.stringify({ text })))).toEqual({ text });
  });

  test("rejects text longer than MAX_TEXT_LENGTH", async () => {
    const text = "a".repeat(MAX_TEXT_LENGTH + 1);
    expect(await readChatRequest(jsonRequest(JSON.stringify({ text })))).toBeUndefined();
  });

  test("rejects a whenBusy value outside followUp/steer", async () => {
    expect(
      await readChatRequest(jsonRequest('{"text":"hello","whenBusy":"queue"}')),
    ).toBeUndefined();
  });

  test("rejects a blank thread", async () => {
    expect(await readChatRequest(jsonRequest('{"text":"hello","thread":"   "}'))).toBeUndefined();
  });

  test("rejects malformed JSON", async () => {
    expect(await readChatRequest(jsonRequest("{not json"))).toBeUndefined();
    expect(await readChatRequest(jsonRequest('{"text":}'))).toBeUndefined();
  });

  test("rejects a chunked body larger than MAX_BODY_BYTES even without content-length", async () => {
    const request = streamedRequest(paddedJson(MAX_BODY_BYTES));
    expect(request.headers.get("content-length")).toBeNull();
    expect(await readChatRequest(request)).toBeUndefined();
  });

  test("accepts an under-cap chunked body built the same way", async () => {
    const request = streamedRequest(paddedJson(10));
    expect(request.headers.get("content-length")).toBeNull();
    expect(await readChatRequest(request)).toEqual({ text: "hello" });
  });

  test("short-circuits when a declared content-length is over the cap", async () => {
    const request = jsonRequest('{"text":"hello"}', {
      "content-length": String(MAX_BODY_BYTES + 1),
    });
    expect(request.headers.get("content-length")).toBe(String(MAX_BODY_BYTES + 1));
    expect(await readChatRequest(request)).toBeUndefined();
  });

  test("returns undefined for a request with no body (text is required)", async () => {
    const request = new Request(CHAT_URL, { method: "POST" });
    expect(request.body).toBeNull();
    expect(await readChatRequest(request)).toBeUndefined();
  });
});
