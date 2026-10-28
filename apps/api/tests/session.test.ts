import * as Effect from "effect/Effect";
import { describe, expect, test } from "vitest";

import {
  authenticate,
  csrfAllows,
  issueSession,
  readCookie,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  sessionCookie,
  verifySession,
} from "../src/session.ts";

const TOKEN = "correct-horse-battery-staple";
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

const issue = async (token = TOKEN, now = NOW): Promise<string> =>
  Effect.runPromise(issueSession(token, now));

const verify = async (value: string, token = TOKEN, now = NOW): Promise<boolean> =>
  Effect.runPromise(verifySession(token, value, now));

const withHeaders = (headers: Record<string, string>, url = "https://mackbot.test/chat"): Request =>
  new Request(url, { headers });

const cookieHeader = (value: string) => ({
  Cookie: `${SESSION_COOKIE}=${value}`,
});

describe("issueSession + verifySession", () => {
  test("a freshly issued value verifies", async () => {
    const value = await issue();
    expect(value).toMatch(/^v1\.\d+\.[\w-]{43}$/u);
    expect(await verify(value)).toBe(true);
  });

  test("a value fails one millisecond past SESSION_MAX_AGE_SECONDS", async () => {
    const value = await issue();
    expect(await verify(value, TOKEN, NOW + SESSION_MAX_AGE_SECONDS * 1000 + 1)).toBe(false);
  });

  test("a value still verifies just before it expires", async () => {
    const value = await issue();
    expect(await verify(value, TOKEN, NOW + SESSION_MAX_AGE_SECONDS * 1000 - 1)).toBe(true);
  });

  test("fails when a character of the signature is flipped", async () => {
    const value = await issue();
    const [version, expires, signature] = value.split(".");
    const flipped = `${signature!.slice(0, 1) === "A" ? "B" : "A"}${signature!.slice(1)}`;
    const tampered = `${version}.${expires}.${flipped}`;
    expect(tampered).not.toBe(value);
    expect(await verify(tampered)).toBe(false);
  });

  test("fails when signed with a different token", async () => {
    const value = await issue("first-token");
    expect(await verify(value, "second-token")).toBe(false);
  });

  test.each([
    ["an empty string", ""],
    ["an unknown version", "v2.1700000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    ["a wrong segment count", "v1.1700000000"],
    ["a non-numeric expiry", "v1.not-a-number.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    ["a signature of the wrong length", "v1.1700000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
  ])("fails for a malformed value: %s", async (_label, value) => {
    expect(await verify(value, TOKEN, 0)).toBe(false);
  });
});

describe("readCookie", () => {
  test("finds the named cookie among several", () => {
    const request = withHeaders({ Cookie: "a=1; mackbot_session=v1.2.sig; b=2" });
    expect(readCookie(request, SESSION_COOKIE)).toBe("v1.2.sig");
  });

  test("tolerates spaces around names and values", () => {
    const request = withHeaders({ Cookie: " a=1 ;  mackbot_session = v1.2.sig ; b=2 " });
    expect(readCookie(request, SESSION_COOKIE)).toBe("v1.2.sig");
  });

  test("returns undefined when the cookie is absent", () => {
    expect(readCookie(withHeaders({ Cookie: "a=1; b=2" }), SESSION_COOKIE)).toBeUndefined();
    expect(readCookie(withHeaders({}), SESSION_COOKIE)).toBeUndefined();
  });

  test("skips a malformed part without an equals sign", () => {
    const request = withHeaders({ Cookie: "garbage; mackbot_session=value" });
    expect(readCookie(request, SESSION_COOKIE)).toBe("value");
  });

  test("returns undefined when the header has no matching part", () => {
    const request = withHeaders({ Cookie: "other=1" });
    expect(readCookie(request, SESSION_COOKIE)).toBeUndefined();
  });
});

describe("sessionCookie", () => {
  const cookieFor = (url: string): string => sessionCookie(new Request(url), "v1.2.sig");

  test("contains the cookie's name and value and the required attributes", () => {
    const cookie = cookieFor("https://mackbot.test/chat");
    expect(cookie.startsWith(`${SESSION_COOKIE}=v1.2.sig`)).toBe(true);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain(`Max-Age=${SESSION_MAX_AGE_SECONDS}`);
  });

  test("adds Secure on https", () => {
    expect(cookieFor("https://mackbot.test/chat")).toContain("Secure");
  });

  test("adds Secure on a non-loopback http host", () => {
    expect(cookieFor("http://mackbot.example.com/chat")).toContain("Secure");
  });

  test.each([["http://localhost:8787"], ["http://127.0.0.1:8787"], ["http://[::1]:8787"]])(
    "omits Secure on loopback http (%s)",
    (url) => {
      expect(cookieFor(url)).not.toContain("Secure");
    },
  );
});

describe("authenticate", () => {
  test("bearer wins over a valid cookie", async () => {
    const value = await issue(TOKEN, Date.now());
    const request = withHeaders({
      Authorization: `Bearer ${TOKEN}`,
      ...cookieHeader(value),
    });
    expect(await Effect.runPromise(authenticate(request, TOKEN))).toBe("bearer");
  });

  test("a valid cookie authenticates as cookie", async () => {
    const value = await issue(TOKEN, Date.now());
    const request = withHeaders(cookieHeader(value));
    expect(await Effect.runPromise(authenticate(request, TOKEN))).toBe("cookie");
  });

  test("no credential returns undefined", async () => {
    expect(await Effect.runPromise(authenticate(withHeaders({}), TOKEN))).toBeUndefined();
  });

  test("an invalid cookie returns undefined", async () => {
    const request = withHeaders({ Cookie: `${SESSION_COOKIE}=not-a-session` });
    expect(await Effect.runPromise(authenticate(request, TOKEN))).toBeUndefined();
  });

  test("an expired cookie returns undefined", async () => {
    const expired = await issue(TOKEN, Date.now() - (SESSION_MAX_AGE_SECONDS + 60) * 1000);
    const request = withHeaders(cookieHeader(expired));
    expect(await Effect.runPromise(authenticate(request, TOKEN))).toBeUndefined();
  });
});

describe("csrfAllows", () => {
  const URL = "https://mackbot.test/chat/hermes";

  test("allows a matching Origin with the CSRF header", () => {
    const request = withHeaders({ Origin: "https://mackbot.test", "X-Mackbot-CSRF": "1" }, URL);
    expect(csrfAllows(request)).toBe(true);
  });

  test("rejects a missing CSRF header", () => {
    const request = withHeaders({ Origin: "https://mackbot.test" }, URL);
    expect(csrfAllows(request)).toBe(false);
  });

  test("rejects a wrong CSRF header value", () => {
    const request = withHeaders({ Origin: "https://mackbot.test", "X-Mackbot-CSRF": "true" }, URL);
    expect(csrfAllows(request)).toBe(false);
  });

  test("rejects a cross-origin Origin", () => {
    const request = withHeaders({ Origin: "https://evil.test", "X-Mackbot-CSRF": "1" }, URL);
    expect(csrfAllows(request)).toBe(false);
  });

  test("rejects a missing Origin", () => {
    const request = withHeaders({ "X-Mackbot-CSRF": "1" }, URL);
    expect(csrfAllows(request)).toBe(false);
  });
});
