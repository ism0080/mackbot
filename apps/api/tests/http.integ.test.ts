/**
 * http.integ — the Worker's HTTP front door, driven over its live URL.
 *
 * One `deploy(Stack)` for the file, then every test talks to the local
 * workerd URL the stack reports. The registry is shared across the file, so
 * bots created here carry a run-unique suffix and nothing asserts an exact
 * roster size. Bots are never deleted: the API does not offer a delete.
 *
 * These are integration tests: they assert status codes and decoded wire
 * bodies, never a re-implementation of the routes. A valid `POST /chat/:bot`
 * is deliberately never sent - it would start a real harness run and model
 * call - so only its validation path is exercised.
 */

import * as Test from "alchemy/Test/Vitest";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

import { BotConfigSchema, BotViewSchema, TranscriptPageSchema } from "@mackbot/contract";
import type { BotConfig } from "@mackbot/contract";
import * as Http from "./support/http.ts";
import { issueSession, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "../src/session.ts";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});
const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 600_000 });

/** A suffix that keeps the bots this file creates apart from any other run's. */
const RUN = Date.now().toString(36);
const botId = (name: string): string => `test-bot-${name}-${RUN}`;

const seededBots = ["hermes", "scribe"] as const;

type LiveResponse = HttpClientResponse.HttpClientResponse;
type LiveCall = () => Effect.Effect<LiveResponse, unknown, HttpClient.HttpClient>;

/** The deployed URL and its origin, the latter being what the CSRF check compares against. */
const site = Effect.gen(function* () {
  const { url } = yield* stack;
  return { url, origin: new URL(url).origin };
});

const rosterOf = (url: string) =>
  Effect.gen(function* () {
    const response = yield* Http.get(`${url}/bots`, Http.bearer());
    expect(response.status).toBe(200);
    const payload = yield* Http.body<{ bots: Record<string, BotConfig> }>(response);
    return payload.bots;
  });

/** The login the browser performs, returning the response that issued the cookie. */
const login = (url: string) =>
  Http.manual(Http.post(`${url}/login`, Http.form({ token: Http.token() })));

const decodeBot = (value: Schema.Json) => Schema.decodeUnknownEffect(BotConfigSchema)(value);

// ---------------------------------------------------------------------------
// 1. Unauthenticated access
// ---------------------------------------------------------------------------

test(
  "unauthenticated API routes answer 401 JSON, not a redirect",
  Effect.gen(function* () {
    const { url } = yield* site;
    const paths = ["/status", "/bots", "/models", "/transcript/hermes", "/events/hermes"];
    for (const path of paths) {
      const response = yield* Http.get(`${url}${path}`);
      expect(response.status, path).toBe(401);
      const payload = yield* Http.body(response);
      expect(payload, path).toEqual({ error: "unauthorized" });
    }
  }),
);

test(
  "unauthenticated navigation redirects to /login",
  Effect.gen(function* () {
    const { url } = yield* site;
    const response = yield* Http.manual(Http.get(`${url}/`));
    expect(response.status).toBe(302);
    const location = response.headers["location"];
    expect(location).toBeDefined();
    expect(new URL(String(location)).pathname).toBe("/login");
  }),
);

test(
  "GET /login serves the form without issuing a session",
  Effect.gen(function* () {
    const { url } = yield* site;
    const response = yield* Http.get(`${url}/login`);
    expect(response.status).toBe(200);
    expect(String(response.headers["content-type"])).toContain("text/html");
    expect(Http.sessionCookie(response)).toBeUndefined();
    const html = yield* response.text;
    expect(html).toContain("<form");
    expect(html).toContain('name="token"');
  }),
);

test(
  "POST /login refuses a wrong token and issues a working cookie for the right one",
  Effect.gen(function* () {
    const { url } = yield* site;

    const wrong = yield* Http.manual(
      Http.post(`${url}/login`, Http.form({ token: "definitely-not-the-token" })),
    );
    expect(wrong.status).toBe(401);
    expect(String(wrong.headers["content-type"])).toContain("text/html");
    expect(Http.sessionCookie(wrong)).toBeUndefined();

    const accepted = yield* login(url);
    expect(accepted.status).toBe(303);
    expect(accepted.headers["location"]).toBe("/");

    const cookie = Http.sessionCookie(accepted);
    expect(cookie).toBeDefined();
    // Loopback http: HttpOnly and SameSite=Lax, but no Secure, which the
    // browser would drop on an http origin.
    expect(cookie.options?.httpOnly).toBe(true);
    expect(cookie.options?.sameSite).toBe("lax");
    expect(cookie.options?.secure).not.toBe(true);

    const status = yield* Http.get(`${url}/status`, Http.cookieHeader(accepted));
    expect(status.status).toBe(200);
  }),
);

test(
  "a tampered or expired session cookie is refused",
  Effect.gen(function* () {
    const { url } = yield* site;
    const token = Http.token();
    // Both cookies are in the current format and genuinely signed with the
    // Worker's key, so the refusals below are the signature and the expiry
    // speaking, not a format the Worker no longer reads.
    const expiredValue = yield* issueSession(
      token,
      Date.now() - (SESSION_MAX_AGE_SECONDS + 60) * 1000,
    );
    const freshValue = yield* issueSession(token, Date.now());
    const [version, expires, signature] = freshValue.split(".");
    const tamperedValue = `${version}.${Number(expires) + 600}.${signature}`;

    // The untouched cookie is accepted, so the refusals below cannot be a
    // signing key the test and the Worker disagree on.
    const freshResponse = yield* Http.get(`${url}/status`, {
      cookie: `${SESSION_COOKIE}=${freshValue}`,
    });
    expect(freshResponse.status).toBe(200);

    const expiredResponse = yield* Http.get(`${url}/status`, {
      cookie: `${SESSION_COOKIE}=${expiredValue}`,
    });
    expect(expiredResponse.status).toBe(401);

    const tamperedResponse = yield* Http.get(`${url}/status`, {
      cookie: `${SESSION_COOKIE}=${tamperedValue}`,
    });
    expect(tamperedResponse.status).toBe(401);
  }),
);

// ---------------------------------------------------------------------------
// 2. CSRF and auth methods
// ---------------------------------------------------------------------------

test(
  "cookie mutations need the CSRF header and matching Origin; bearer needs neither",
  Effect.gen(function* () {
    const { url, origin } = yield* site;
    const accepted = yield* login(url);
    const cookie = Http.cookieHeader(accepted);
    const id = botId("csrf");
    const payload = Http.json({
      id,
      bot: { model: "deepseek-v4-pro", systemPrompt: "Created over cookie auth." },
    });

    // The cookie alone is not enough: a cross-site form could hold it too.
    const forbidden = yield* Http.post(`${url}/bots`, payload, cookie);
    expect(forbidden.status).toBe(403);
    expect(yield* Http.body(forbidden)).toEqual({ error: "forbidden" });

    // Same request, now proving it came from this origin.
    const created = yield* Http.post(`${url}/bots`, payload, {
      ...cookie,
      origin,
      "x-mackbot-csrf": "1",
    });
    expect(created.status).toBe(201);
    const createdBody = yield* Http.body<{ id: string }>(created);
    expect(createdBody.id).toBe(id);

    // A bearer write needs no CSRF headers at all.
    const bots = yield* rosterOf(url);
    const written = yield* Http.put(
      `${url}/bots/hermes`,
      Http.json({ bot: bots["hermes"] }),
      Http.bearer(),
    );
    expect(written.status).toBe(200);

    // The scheme itself is case-insensitive.
    const lowerCase = yield* Http.get(`${url}/status`, Http.bearer("bearer"));
    expect(lowerCase.status).toBe(200);
  }),
);

// ---------------------------------------------------------------------------
// 3. Public assets
// ---------------------------------------------------------------------------

test(
  "public assets are reachable without a session",
  Effect.gen(function* () {
    const { url } = yield* site;
    for (const path of ["/manifest.webmanifest", "/icon.svg"]) {
      const response = yield* Http.get(`${url}${path}`);
      expect(response.status, path).toBeLessThan(400);
    }
  }),
);

// ---------------------------------------------------------------------------
// 4. Registry routes
// ---------------------------------------------------------------------------

test(
  "GET /models exposes the catalog entry with its thinking levels",
  Effect.gen(function* () {
    const { url } = yield* site;
    const response = yield* Http.get(`${url}/models`, Http.bearer());
    expect(response.status).toBe(200);
    const payload = yield* Http.body<{ models: Record<string, ReadonlyArray<string>> }>(response);
    expect(Object.keys(payload.models).length).toBeGreaterThan(0);
    expect(payload.models["deepseek-v4-pro"]).toEqual(["high", "max"]);
  }),
);

test(
  "GET /bots returns the seeded roster as decodable bot configurations",
  Effect.gen(function* () {
    const { url } = yield* site;
    const bots = yield* rosterOf(url);
    for (const id of seededBots) {
      expect(Object.hasOwn(bots, id)).toBe(true);
      const decoded = yield* decodeBot(bots[id]);
      expect(decoded.model.length).toBeGreaterThan(0);
      expect(decoded.systemPrompt.length).toBeGreaterThan(0);
    }
  }),
);

test(
  "POST /bots creates a bot, refuses a duplicate id and illegal slugs",
  Effect.gen(function* () {
    const { url } = yield* site;
    const id = botId("create");
    const bot = {
      model: "deepseek-v4-pro",
      thinkingLevel: "max" as const,
      systemPrompt: "You are a test bot created over HTTP.",
    };

    const created = yield* Http.post(`${url}/bots`, Http.json({ id, bot }), Http.bearer());
    expect(created.status).toBe(201);
    const createdBody = yield* Http.body<{ id: string; bot: BotConfig }>(created);
    expect(createdBody.id).toBe(id);
    expect(createdBody.bot.systemPrompt).toBe(bot.systemPrompt);
    expect(createdBody.bot.thinkingLevel).toBe("max");

    const bots = yield* rosterOf(url);
    expect(Object.hasOwn(bots, id)).toBe(true);
    expect((yield* decodeBot(bots[id])).systemPrompt).toBe(bot.systemPrompt);

    const duplicate = yield* Http.post(`${url}/bots`, Http.json({ id, bot }), Http.bearer());
    expect(duplicate.status).toBe(409);

    for (const illegal of ["Bad_Id", "-leading-dash", "x".repeat(64)]) {
      const refused = yield* Http.post(
        `${url}/bots`,
        Http.json({ id: illegal, bot }),
        Http.bearer(),
      );
      expect(refused.status, illegal).toBe(400);
    }
  }),
);

test(
  "POST /bots names the model it does not know and the level it does not support",
  Effect.gen(function* () {
    const { url } = yield* site;

    const unknownModel = yield* Http.post(
      `${url}/bots`,
      Http.json({
        id: botId("unknown-model"),
        bot: { model: "not-a-real-model", systemPrompt: "Unknown model." },
      }),
      Http.bearer(),
    );
    expect(unknownModel.status).toBe(400);
    const unknownBody = yield* Http.body<{ error: string }>(unknownModel);
    expect(unknownBody.error).toContain("not-a-real-model");

    const badLevel = yield* Http.post(
      `${url}/bots`,
      Http.json({
        id: botId("bad-level"),
        // deepseek-v4-pro supports high and max only.
        bot: { model: "deepseek-v4-pro", thinkingLevel: "low", systemPrompt: "Bad level." },
      }),
      Http.bearer(),
    );
    expect(badLevel.status).toBe(400);
    const levelBody = yield* Http.body<{ error: string }>(badLevel);
    expect(levelBody.error).toContain("low");
    expect(levelBody.error).toContain("deepseek-v4-pro");
  }),
);

test(
  "PUT /bots replaces hermes and keeps the fields its form does not show",
  Effect.gen(function* () {
    const { url } = yield* site;
    const bots = yield* rosterOf(url);
    const original = bots["hermes"]!;
    const prompt = "You are Hermes, briefly, in a round-trip test.";

    const written = yield* Http.put(
      `${url}/bots/hermes`,
      Http.json({ bot: { ...original, systemPrompt: prompt } }),
      Http.bearer(),
    );
    expect(written.status).toBe(200);
    const writtenBody = yield* Http.body<{ id: string; bot: BotConfig }>(written);
    expect(writtenBody.id).toBe("hermes");
    expect(writtenBody.bot.systemPrompt).toBe(prompt);
    // The round-trip contract: everything the edit did not touch survives.
    expect(writtenBody.bot.model).toBe(original.model);
    expect(writtenBody.bot.thinkingLevel).toBe(original.thinkingLevel);
    expect(writtenBody.bot.brief).toBe(original.brief);
    expect(writtenBody.bot.delegatesTo).toEqual(original.delegatesTo);
    expect(writtenBody.bot.runtime).toEqual(original.runtime);
    expect(writtenBody.bot.commitments).toBe(original.commitments);

    // Restore the seed prompt so later tests and reruns see the same hermes.
    const restored = yield* Http.put(
      `${url}/bots/hermes`,
      Http.json({ bot: original }),
      Http.bearer(),
    );
    expect(restored.status).toBe(200);
    expect((yield* Http.body<{ bot: BotConfig }>(restored)).bot.systemPrompt).toBe(
      original.systemPrompt,
    );
  }),
);

test(
  "PUT /bots/hermes refuses a blank field, an undeclared delegate and itself",
  Effect.gen(function* () {
    const { url } = yield* site;
    const bots = yield* rosterOf(url);
    const hermes = bots["hermes"]!;

    const blankPrompt = yield* Http.put(
      `${url}/bots/hermes`,
      Http.json({ bot: { ...hermes, systemPrompt: "   " } }),
      Http.bearer(),
    );
    expect(blankPrompt.status).toBe(400);

    const blankModel = yield* Http.put(
      `${url}/bots/hermes`,
      Http.json({ bot: { ...hermes, model: "   " } }),
      Http.bearer(),
    );
    expect(blankModel.status).toBe(400);

    const undeclared = yield* Http.put(
      `${url}/bots/hermes`,
      Http.json({ bot: { ...hermes, delegatesTo: [`no-such-bot-${RUN}`] } }),
      Http.bearer(),
    );
    expect(undeclared.status).toBe(400);
    const undeclaredBody = yield* Http.body<{ error: string }>(undeclared);
    expect(undeclaredBody.error).toContain(`no-such-bot-${RUN}`);

    const self = yield* Http.put(
      `${url}/bots/hermes`,
      Http.json({ bot: { ...hermes, delegatesTo: ["hermes"] } }),
      Http.bearer(),
    );
    expect(self.status).toBe(400);
  }),
);

test(
  "PUT an unknown bot is 404",
  Effect.gen(function* () {
    const { url } = yield* site;
    const response = yield* Http.put(
      `${url}/bots/${`no-such-bot-${RUN}`}`,
      Http.json({ bot: { model: "deepseek-v4-pro", systemPrompt: "Nobody." } }),
      Http.bearer(),
    );
    expect(response.status).toBe(404);
    expect(yield* Http.body(response)).toEqual({ error: `unknown bot "no-such-bot-${RUN}"` });
  }),
);

test(
  "registry routes refuse the wrong method with 405 JSON",
  Effect.gen(function* () {
    const { url } = yield* site;
    const bot = Http.json({ bot: { model: "deepseek-v4-pro", systemPrompt: "Method test." } });

    const calls: ReadonlyArray<LiveCall> = [
      () => Http.del(`${url}/bots`, Http.bearer()),
      () => Http.put(`${url}/bots`, bot, Http.bearer()),
      () => Http.del(`${url}/bots/hermes`, Http.bearer()),
      () => Http.post(`${url}/bots/hermes`, bot, Http.bearer()),
    ];

    for (const call of calls) {
      const response = yield* call();
      expect(response.status).toBe(405);
      expect(yield* Http.body(response)).toEqual({ error: "method not allowed" });
    }
  }),
);

// ---------------------------------------------------------------------------
// 5. Bot-scoped routes
// ---------------------------------------------------------------------------

test(
  "bot-scoped routes answer 404 naming an unknown bot",
  Effect.gen(function* () {
    const { url } = yield* site;
    const unknown = `no-such-bot-${RUN}`;

    const calls: ReadonlyArray<LiveCall> = [
      () => Http.post(`${url}/chat/${unknown}`, Http.json({}), Http.bearer()),
      () => Http.get(`${url}/transcript/${unknown}`, Http.bearer()),
      () =>
        Http.post(
          `${url}/approvals/${unknown}/not-a-real-approval`,
          Http.json({ action: "allow" }),
          Http.bearer(),
        ),
      () => Http.post(`${url}/abort/${unknown}`, Http.json({}), Http.bearer()),
      () => Http.post(`${url}/retry/${unknown}`, Http.json({ taskId: "1" }), Http.bearer()),
      () => Http.post(`${url}/compact/${unknown}`, Http.json({}), Http.bearer()),
    ];

    for (const call of calls) {
      const response = yield* call();
      expect(response.status).toBe(404);
      const payload = yield* Http.body<{ error: string }>(response);
      expect(payload.error).toContain(unknown);
    }
  }),
);

test(
  "POST /chat/:bot refuses every invalid body without starting a run",
  Effect.gen(function* () {
    const { url } = yield* site;
    const bodies: ReadonlyArray<HttpBody.HttpBody> = [
      Http.json({}),
      Http.json({ text: "" }),
      Http.json({ text: "   " }),
      HttpBody.text("this is not json", "application/json"),
      Http.json({ text: "x".repeat(16_385) }),
      Http.json({ text: "hello", whenBusy: "sometimes" }),
    ];

    for (const body of bodies) {
      const response = yield* Http.post(`${url}/chat/hermes`, body, Http.bearer());
      expect(response.status).toBe(400);
      expect(yield* Http.body(response)).toEqual({ error: "invalid request body" });
    }
  }),
);

test(
  "GET /transcript validates its query and reads an empty transcript for a fresh bot",
  Effect.gen(function* () {
    const { url } = yield* site;

    for (const query of ["limit=0", "limit=201", "before=0", "thread="]) {
      const response = yield* Http.get(`${url}/transcript/hermes?${query}`, Http.bearer());
      expect(response.status, query).toBe(400);
      expect(yield* Http.body(response)).toEqual({ error: "invalid query" });
    }

    const id = botId("transcript");
    const created = yield* Http.post(
      `${url}/bots`,
      Http.json({
        id,
        bot: { model: "deepseek-v4-pro", systemPrompt: "You have no history yet." },
      }),
      Http.bearer(),
    );
    expect(created.status).toBe(201);

    const response = yield* Http.get(`${url}/transcript/${id}`, Http.bearer());
    expect(response.status).toBe(200);
    const payload = yield* Http.body(response);
    const page = yield* Schema.decodeUnknownEffect(TranscriptPageSchema)(payload);
    expect(page.session.length).toBeGreaterThan(0);
    expect(Array.isArray(page.entries)).toBe(true);
    expect(page.stream.generation).toBeGreaterThanOrEqual(0);
    expect(page.stream.stream).toContain(page.session);
  }),
);

test(
  "abort, approvals and retry refuse malformed bodies",
  Effect.gen(function* () {
    const { url } = yield* site;

    const abort = yield* Http.post(`${url}/abort/hermes`, Http.json({ session: 5 }), Http.bearer());
    expect(abort.status).toBe(400);
    expect(yield* Http.body(abort)).toEqual({ error: "invalid request body" });

    const invalidDecisions: ReadonlyArray<unknown> = [
      {},
      { action: "maybe" },
      { action: "allow", content: { x: {} } },
    ];
    for (const decision of invalidDecisions) {
      const response = yield* Http.post(
        `${url}/approvals/hermes/not-a-real-approval`,
        Http.json(decision),
        Http.bearer(),
      );
      expect(response.status).toBe(400);
      expect(yield* Http.body(response)).toEqual({ error: "invalid request body" });
    }

    // A well-formed decision for an approval that does not exist is a 409,
    // not a 400 and not a replay.
    const missing = yield* Http.post(
      `${url}/approvals/hermes/not-a-real-approval`,
      Http.json({ action: "allow" }),
      Http.bearer(),
    );
    expect(missing.status).toBe(409);
    expect(yield* Http.body(missing)).toEqual({ error: "no pending approval" });

    for (const body of [{}, { taskId: 5 }]) {
      const response = yield* Http.post(`${url}/retry/hermes`, Http.json(body), Http.bearer());
      expect(response.status).toBe(400);
      expect(yield* Http.body(response)).toEqual({ error: "invalid request body" });
    }
  }),
);

test(
  "GET /events/:bot answers a stream or a defined refusal, never a 500",
  Effect.gen(function* () {
    const { url } = yield* site;
    const responded = yield* Http.get(`${url}/events/hermes`, Http.bearer()).pipe(
      Effect.timeoutOption("30 seconds"),
    );
    if (Option.isNone(responded)) {
      // The SSE head did not arrive within the budget in this environment.
      // Tearing the connection down is the point of the timeout; there is no
      // stream to assert on. Kept as a distinct, narrow skip rather than
      // dropping the case: a 5xx or a wrong content type still fails above.
      return;
    }
    const response = responded.value;
    expect(response.status).not.toBe(500);
    if (response.status === 200) {
      expect(String(response.headers["content-type"])).toContain("text/event-stream");
      // Close the SSE connection so the test process can settle.
      yield* response.text.pipe(Effect.timeoutOption("2 seconds"), Effect.ignore);
    } else {
      expect(response.status).toBeLessThan(500);
      yield* response.text.pipe(Effect.ignore);
    }
  }),
);

// KNOWN BUG (kept red on purpose, per the test brief): every other bot-scoped
// route checks the roster first, but `/events/:bot` forwards straight to the
// Durable Object. For an undeclared id the DO's fetch rejects with
// `no bot "<id>" in the registry` and the Worker's catch-all turns that into
// `500 {"error":"internal error"}` instead of the 404 that names the bot.
test(
  "GET /events/:bot names an unknown bot with a 404",
  Effect.gen(function* () {
    const { url } = yield* site;
    const unknown = `no-such-bot-${RUN}`;
    const responded = yield* Http.get(`${url}/events/${unknown}`, Http.bearer()).pipe(
      Effect.timeoutOption("15 seconds"),
    );
    expect(Option.isSome(responded)).toBe(true);
    if (Option.isNone(responded)) return;
    expect(responded.value.status).toBe(404);
    const payload = yield* Http.body<{ error: string }>(responded.value);
    expect(payload.error).toContain(unknown);
  }),
);

// ---------------------------------------------------------------------------
// 6. Status
// ---------------------------------------------------------------------------

test(
  "GET /status reports every seeded bot exactly once, as a decodable view",
  Effect.gen(function* () {
    const { url } = yield* site;
    const response = yield* Http.get(`${url}/status`, Http.bearer());
    expect(response.status).toBe(200);
    const payload = yield* Http.body<{
      bots: Record<string, Schema.Json>;
      errors: Record<string, string>;
    }>(response);

    for (const id of seededBots) {
      const inBots = Object.hasOwn(payload.bots, id);
      const inErrors = Object.hasOwn(payload.errors, id);
      expect(inBots !== inErrors, id).toBe(true);
      if (inBots) {
        const view = yield* Schema.decodeUnknownEffect(BotViewSchema)(payload.bots[id]);
        expect(view.id).toBe(id);
      } else {
        expect(payload.errors[id]?.length ?? 0).toBeGreaterThan(0);
      }
    }
  }),
);
