import { describe, expect, test } from "vitest";

import type { BotConfig } from "../src/bots.ts";
import type { Env } from "../src/env.ts";
import { API_CONTENT_SECURITY_POLICY } from "../src/http.ts";
import { handleFetch } from "../src/router.ts";

const TOKEN = "correct-horse-battery-staple";
const ORIGIN = "https://mackbot.test";
const ROSTER = { hermes: { model: "deepseek-v4-pro", systemPrompt: "You are a test bot." } };

interface Recorded {
  readonly compacts: unknown[][];
  readonly retries: string[];
  /** The configuration each bot's status was handed, by bot id. */
  readonly statuses: Record<string, BotConfig | undefined>;
  rosterReads: number;
}

/** The bindings the router reaches, with the Durable Objects played by plain objects. */
const fakeEnv = (recorded: Recorded, registry: "up" | "down" = "up"): Env => {
  const env = {
    CHAT_BEARER_TOKEN: TOKEN,
    Registry: {
      getByName: () => ({
        roster: async () => {
          recorded.rosterReads += 1;
          if (registry === "down") throw new Error("registry isolate is gone");
          return ROSTER;
        },
      }),
    },
    Bot: {
      getByName: (name: string) => ({
        status: async (config?: BotConfig) => {
          recorded.statuses[name] = config;
          return { id: name };
        },
        compact: async (...args: unknown[]) => {
          recorded.compacts.push(args);
          return { bot: name, taskId: "7" };
        },
        retry: async (taskId: string) => {
          recorded.retries.push(taskId);
          return { bot: name, taskId, retried: false };
        },
      }),
    },
    ASSETS: { fetch: async () => new Response("<!doctype html>", { status: 200 }) },
  };
  // SAFETY: the test drives only the routes these stand-ins answer.
  // oxlint-disable-next-line forge/no-chained-type-assertions -- a partial test double of the Worker's bindings
  return env as unknown as Env;
};

const record = (): Recorded => ({ compacts: [], retries: [], statuses: {}, rosterReads: 0 });

const post = (path: string, body: string): Request =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body,
  });

const expectSecured = (response: Response): void => {
  expect(response.headers.get("Content-Security-Policy")).toBe(API_CONTENT_SECURITY_POLICY);
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
};

describe("session and task ids at the front door", () => {
  test.each([
    ["/compact/hermes", '{"session":"abc"}'],
    ["/compact/hermes", '{"session":"0"}'],
    ["/abort/hermes", '{"session":"1.5"}'],
    ["/retry/hermes", '{"taskId":"not-a-task"}'],
  ])("%s with %s is a 400 that never reaches the bot", async (path, body) => {
    const recorded = record();
    const response = await handleFetch(post(path, body), fakeEnv(recorded));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid request body" });
    expect(recorded.compacts).toEqual([]);
    expect(recorded.retries).toEqual([]);
  });

  test("a numeric session reaches the bot", async () => {
    const recorded = record();
    const response = await handleFetch(
      post("/compact/hermes", '{"session":"3","instructions":"keep the plan"}'),
      fakeEnv(recorded),
    );
    expect(response.status).toBe(200);
    expect(recorded.compacts).toEqual([["3", "keep the plan"]]);
  });

  test("an empty body compacts the root", async () => {
    const recorded = record();
    expect((await handleFetch(post("/compact/hermes", ""), fakeEnv(recorded))).status).toBe(200);
    expect(recorded.compacts).toEqual([[undefined, undefined]]);
  });
});

describe("bot-scoped routes", () => {
  test("an undeclared bot is a 404", async () => {
    const response = await handleFetch(post("/compact/nobody", "{}"), fakeEnv(record()));
    expect(response.status).toBe(404);
  });

  test("the wrong method is a 405", async () => {
    const request = new Request(`${ORIGIN}/compact/hermes`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect((await handleFetch(request, fakeEnv(record()))).status).toBe(405);
  });
});

describe("security headers", () => {
  test("a JSON answer carries them", async () => {
    const response = await handleFetch(post("/compact/hermes", "{}"), fakeEnv(record()));
    expectSecured(response);
  });

  test("a refusal carries them", async () => {
    const response = await handleFetch(new Request(`${ORIGIN}/status`), fakeEnv(record()));
    expect(response.status).toBe(401);
    expectSecured(response);
  });

  test("the redirect to the login page carries them", async () => {
    const response = await handleFetch(new Request(`${ORIGIN}/somewhere`), fakeEnv(record()));
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`${ORIGIN}/login`);
    expectSecured(response);
  });

  test("the built app is served as the assets binding answers it", async () => {
    const request = new Request(`${ORIGIN}/`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const response = await handleFetch(request, fakeEnv(record()));
    expect(await response.text()).toBe("<!doctype html>");
    expect(response.headers.get("Content-Security-Policy")).toBeNull();
  });
});

describe("the registry", () => {
  const get = (path: string): Request =>
    new Request(`${ORIGIN}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });

  test("a registry that does not answer is a 503, not a 500", async () => {
    const response = await handleFetch(get("/bots"), fakeEnv(record(), "down"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "registry unavailable" });
    expectSecured(response);
  });

  test("a bot-scoped route behind a registry that does not answer is a 503", async () => {
    const response = await handleFetch(post("/compact/hermes", "{}"), fakeEnv(record(), "down"));
    expect(response.status).toBe(503);
  });

  test("/status reads the roster once and hands each bot its own configuration", async () => {
    const recorded = record();
    const response = await handleFetch(get("/status"), fakeEnv(recorded));
    expect(response.status).toBe(200);
    expect(recorded.rosterReads).toBe(1);
    expect(recorded.statuses).toEqual({ hermes: ROSTER.hermes });
  });
});
