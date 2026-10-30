import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { handleLogin, handleLogout } from "../src/auth.ts";
import type { LoginGuard } from "../src/auth.ts";
import { LOGIN_CONTENT_SECURITY_POLICY } from "../src/login-page.ts";
import {
  createLoginThrottle,
  LOGIN_FAILURE_LIMIT,
  LOGIN_WINDOW_MS,
} from "../src/login-throttle.ts";
import type { SqlStorage, SqlValue } from "../src/sql.ts";
import { SESSION_COOKIE } from "../src/session.ts";

const TOKEN = "correct-horse-battery-staple";
const ORIGIN = "https://mackbot.test";

/** A Durable Object's SQLite, played by Node's. */
const memoryStorage = (): SqlStorage => {
  const db = new DatabaseSync(":memory:");
  return {
    sql: {
      exec: (query: string, ...bindings: SqlValue[]) => {
        const rows = db.prepare(query).all(...bindings);
        return { toArray: () => rows };
      },
    },
  };
};

/** The guard the Worker reaches over RPC, on a clock the test moves. */
const guardAt = (clock: { now: number }): LoginGuard => {
  const throttle = createLoginThrottle(memoryStorage());
  return {
    loginRetryAfter: async (client) => throttle.retryAfter(client, clock.now),
    recordLoginFailure: async (client) => throttle.recordFailure(client, clock.now),
    clearLoginFailures: async (client) => throttle.clear(client),
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

const failTimes = async (guard: LoginGuard, times: number, client?: string): Promise<void> => {
  for (let attempt = 0; attempt < times; attempt += 1) {
    expect((await handleLogin(login("wrong", client), TOKEN, guard)).status).toBe(401);
  }
};

describe("handleLogin", () => {
  test("the right token sets the session cookie and redirects home", async () => {
    const response = await handleLogin(login(TOKEN), TOKEN, guardAt({ now: 0 }));
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/");
    expect(response.headers.get("Set-Cookie")).toMatch(new RegExp(`^${SESSION_COOKIE}=v2\\.`, "u"));
  });

  test("a client locked out by failures is refused even with the right token", async () => {
    const guard = guardAt({ now: 1_000 });
    await failTimes(guard, LOGIN_FAILURE_LIMIT);
    const response = await handleLogin(login(TOKEN), TOKEN, guard);
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBe(LOGIN_WINDOW_MS / 1000);
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  test("the lockout is per client", async () => {
    const guard = guardAt({ now: 1_000 });
    await failTimes(guard, LOGIN_FAILURE_LIMIT, "198.51.100.1");
    expect((await handleLogin(login(TOKEN, "198.51.100.2"), TOKEN, guard)).status).toBe(303);
  });

  test("the lockout ends when the window that started with the first failure has passed", async () => {
    const clock = { now: 1_000 };
    const guard = guardAt(clock);
    await failTimes(guard, LOGIN_FAILURE_LIMIT);
    clock.now += LOGIN_WINDOW_MS;
    expect((await handleLogin(login(TOKEN), TOKEN, guard)).status).toBe(303);
  });

  test("a success clears the client's failures", async () => {
    const guard = guardAt({ now: 1_000 });
    await failTimes(guard, LOGIN_FAILURE_LIMIT - 1);
    expect((await handleLogin(login(TOKEN), TOKEN, guard)).status).toBe(303);
    await failTimes(guard, LOGIN_FAILURE_LIMIT - 1);
    expect((await handleLogin(login(TOKEN), TOKEN, guard)).status).toBe(303);
  });

  test("the login page carries its own policy and may not be framed", async () => {
    const response = await handleLogin(new Request(`${ORIGIN}/login`), TOKEN, guardAt({ now: 0 }));
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
