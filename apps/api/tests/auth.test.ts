import { describe, expect, test } from "vitest";

import { handleLogin, handleLogout } from "../src/auth.ts";
import type { LoginLimiter } from "../src/auth.ts";
import { LOGIN_ATTEMPT_LIMIT, LOGIN_ATTEMPT_PERIOD_SECONDS } from "../src/login-limit.ts";
import { LOGIN_CONTENT_SECURITY_POLICY } from "../src/login-page.ts";
import { SESSION_COOKIE } from "../src/session.ts";

const TOKEN = "correct-horse-battery-staple";
const ORIGIN = "https://mackbot.test";

/** A stand-in for the rate-limiting binding: a fixed allowance per key, recording each key it is asked about. */
const allowance = (limit = LOGIN_ATTEMPT_LIMIT): LoginLimiter & { readonly keys: string[] } => {
  const keys: string[] = [];
  return {
    keys,
    limit: async ({ key }) => {
      keys.push(key);
      return { success: keys.filter((seen) => seen === key).length <= limit };
    },
  };
};

const login = (token: string, client = "203.0.113.7"): Request =>
  new Request(`${ORIGIN}/login`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "CF-Connecting-IP": client,
    },
    body: new URLSearchParams({ token }).toString(),
  });

describe("handleLogin", () => {
  test("the right token sets the session cookie and redirects home", async () => {
    const response = await handleLogin(login(TOKEN), TOKEN, allowance());
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/");
    expect(response.headers.get("Set-Cookie")).toMatch(new RegExp(`^${SESSION_COOKIE}=v2\\.`, "u"));
  });

  test("a wrong token is refused without a cookie", async () => {
    const response = await handleLogin(login("wrong"), TOKEN, allowance());
    expect(response.status).toBe(401);
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  test("attempts are counted per client address", async () => {
    const limiter = allowance();
    await handleLogin(login("wrong", "198.51.100.1"), TOKEN, limiter);
    await handleLogin(login(TOKEN, "198.51.100.2"), TOKEN, limiter);
    expect(limiter.keys).toEqual(["198.51.100.1", "198.51.100.2"]);
  });

  test("a client past its allowance is refused even with the right token", async () => {
    const limiter = allowance();
    for (let attempt = 0; attempt < LOGIN_ATTEMPT_LIMIT; attempt += 1) {
      expect((await handleLogin(login("wrong"), TOKEN, limiter)).status).toBe(401);
    }
    const response = await handleLogin(login(TOKEN), TOKEN, limiter);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe(String(LOGIN_ATTEMPT_PERIOD_SECONDS));
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect((await handleLogin(login(TOKEN, "198.51.100.9"), TOKEN, limiter)).status).toBe(303);
  });

  test("a limiter that cannot answer refuses the attempt", async () => {
    const failing: LoginLimiter = {
      limit: () => Promise.reject(new Error("rate limiter unavailable")),
    };
    const response = await handleLogin(login(TOKEN), TOKEN, failing);
    expect(response.status).toBe(429);
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  test("showing the form spends no attempt", async () => {
    const limiter = allowance();
    const response = await handleLogin(new Request(`${ORIGIN}/login`), TOKEN, limiter);
    expect(response.status).toBe(200);
    expect(limiter.keys).toEqual([]);
  });

  test("the login page carries its own policy and may not be framed", async () => {
    const response = await handleLogin(new Request(`${ORIGIN}/login`), TOKEN, allowance());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toBe(LOGIN_CONTENT_SECURITY_POLICY);
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
});

describe("handleLogout", () => {
  const logout = (headers: Record<string, string>, method = "POST"): Request =>
    new Request(`${ORIGIN}/logout`, { method, headers });

  test("clears the session cookie for a same-origin request", () => {
    const response = handleLogout(logout({ Origin: ORIGIN, "X-Mackbot-CSRF": "1" }));
    expect(response.status).toBe(204);
    const cookie = response.headers.get("Set-Cookie") ?? "";
    expect(cookie.startsWith(`${SESSION_COOKIE}=;`)).toBe(true);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Path=/");
  });

  test("refuses a cross-site request", () => {
    const response = handleLogout(logout({ Origin: "https://evil.test", "X-Mackbot-CSRF": "1" }));
    expect(response.status).toBe(403);
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  test("answers only POST", () => {
    expect(handleLogout(logout({}, "GET")).status).toBe(405);
  });
});
