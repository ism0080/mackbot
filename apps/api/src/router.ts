/**
 * router - the Worker's front door: who may ask, and which handler answers.
 *
 * `/login` and `/logout` answer anyone; every other route is behind
 * {@link authorize}. Every response the Worker generates itself carries the
 * security headers; everything that is not one of its routes is the built app,
 * served by the assets binding as it is.
 */

import * as Effect from "effect/Effect";

import { handleLogin, handleLogout, LOGIN_GUARD_NAME } from "./auth.ts";
import type { Env } from "./env.ts";
import { describeCause } from "./errors.ts";
import { jsonError, methodNotAllowed, secured, unknownBot } from "./http.ts";
import { cronOperationId } from "./operation.ts";
import {
  handleAbort,
  handleApproval,
  handleBotCreate,
  handleBotWrite,
  handleChat,
  handleCompact,
  handleEvents,
  handleModels,
  handleRetry,
  handleRoster,
  handleStatus,
  handleTranscript,
  readRoster,
} from "./routes.ts";
import type { BotScoped } from "./routes.ts";
import { RegistryUnavailable } from "./services/bot-registry.ts";
import { authenticate, csrfAllows } from "./session.ts";

/** A route under one bot: its path, the one method it answers, and its handler. */
interface BotRoute {
  readonly path: RegExp;
  readonly method: "GET" | "POST";
  readonly handle: (scoped: BotScoped) => Promise<Response>;
}

const BOT_ROUTES: readonly BotRoute[] = [
  { path: /^\/chat\/([^/]+)$/u, method: "POST", handle: handleChat },
  { path: /^\/events\/([^/]+)$/u, method: "GET", handle: handleEvents },
  { path: /^\/transcript\/([^/]+)$/u, method: "GET", handle: handleTranscript },
  { path: /^\/approvals\/([^/]+)\/([^/]+)$/u, method: "POST", handle: handleApproval },
  { path: /^\/abort\/([^/]+)$/u, method: "POST", handle: handleAbort },
  { path: /^\/retry\/([^/]+)$/u, method: "POST", handle: handleRetry },
  { path: /^\/compact\/([^/]+)$/u, method: "POST", handle: handleCompact },
];

const BOT_CONFIG_ROUTE = /^\/bots\/([^/]+)$/u;

/**
 * The paths that answer with JSON rather than with the login page.
 *
 * The registry's own routes are API routes: a browser that asks for the
 * roster without a credential is a broken client, not a navigation, and a
 * redirect would decode as one.
 */
const API_PATHS = new Set(["/status", "/bots", "/models"]);

const answersWithJson = (pathname: string): boolean =>
  API_PATHS.has(pathname) ||
  BOT_CONFIG_ROUTE.test(pathname) ||
  BOT_ROUTES.some((route) => route.path.test(pathname));

const READ_METHODS = new Set(["GET", "HEAD"]);

// Paths that must be reachable without a session, because the browser or the
// operating system fetches them before it can authenticate: the manifest the
// install prompt reads, the icons the home screen uses, and the favicon.
const PUBLIC_ASSETS = new Set([
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
  "/favicon.ico",
]);

/**
 * The refusal for a request that may not continue, or `undefined` when it may.
 * A browser navigation without a credential is sent to the login page; an API
 * call gets JSON, because a redirect would decode as a broken response.
 */
const authorize = async (request: Request, env: Env, url: URL): Promise<Response | undefined> => {
  if (PUBLIC_ASSETS.has(url.pathname)) return undefined;
  const method = await Effect.runPromise(authenticate(request, env.CHAT_BEARER_TOKEN));
  const mutates = !READ_METHODS.has(request.method);
  if (method === undefined) {
    return answersWithJson(url.pathname) || mutates
      ? jsonError(401, "unauthorized")
      : Response.redirect(new URL("/login", request.url).toString(), 302);
  }
  if (method === "cookie" && mutates && !csrfAllows(request)) {
    return jsonError(403, "forbidden");
  }
  return undefined;
};

/**
 * The registry's own routes: the roster, the models the Worker knows, and a
 * bot's configuration. `undefined` means the path is not one of them.
 */
const registryRoute = async (
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | undefined> => {
  if (url.pathname === "/status") {
    return request.method === "GET" ? await handleStatus(env) : methodNotAllowed();
  }
  if (url.pathname === "/bots") {
    if (request.method === "GET") return await handleRoster(env);
    return request.method === "POST" ? await handleBotCreate(request, env) : methodNotAllowed();
  }
  if (url.pathname === "/models") {
    return request.method === "GET" ? handleModels() : methodNotAllowed();
  }
  const bot = BOT_CONFIG_ROUTE.exec(url.pathname);
  if (bot === null) return undefined;
  return request.method === "PUT"
    ? await handleBotWrite(request, env, bot[1]!)
    : methodNotAllowed();
};

/**
 * A route under one bot. The bot is looked up in the roster before any
 * handler runs, so an undeclared id answers `404` on every bot-scoped route
 * rather than reaching the Durable Object, whose "no bot in the registry"
 * rejection would surface as a `500`.
 */
const botRoute = async (request: Request, env: Env, url: URL): Promise<Response | undefined> => {
  for (const route of BOT_ROUTES) {
    const path = route.path.exec(url.pathname);
    if (path === null) continue;
    if (request.method !== route.method) return methodNotAllowed();
    const botId = path[1]!;
    const roster = await readRoster(env);
    if (!Object.hasOwn(roster, botId)) return unknownBot(botId);
    return await route.handle({ request, url, botId, bot: env.Bot.getByName(botId), path });
  }
  return undefined;
};

/** The Worker's own answer, or `undefined` when the request is for the built app. */
const workerRoute = async (request: Request, env: Env, url: URL): Promise<Response | undefined> => {
  if (url.pathname === "/login") {
    return await handleLogin(request, env.CHAT_BEARER_TOKEN, env.Bot.getByName(LOGIN_GUARD_NAME));
  }
  if (url.pathname === "/logout") return handleLogout(request);
  return (
    (await authorize(request, env, url)) ??
    (await registryRoute(request, env, url)) ??
    (await botRoute(request, env, url))
  );
};

const respond = async (request: Request, env: Env): Promise<Response> => {
  const own = await workerRoute(request, env, new URL(request.url));
  // Everything that is not this Worker's own route is the built app. The
  // assets binding applies the SPA fallback for a deep link.
  return own === undefined ? await env.ASSETS.fetch(request) : secured(own);
};

export const handleFetch = (request: Request, env: Env): Promise<Response> =>
  Effect.runPromise(
    Effect.tryPromise({ try: () => respond(request, env), catch: (cause) => cause }).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          // Never leak a stack or internal detail: log the cause, return JSON.
          console.error(`mackbot: request failed: ${describeCause(cause)}`);
          // The roster could not be read: the registry is down, not the
          // request wrong, so the client is told to come back rather than
          // that the Worker broke.
          return cause instanceof RegistryUnavailable
            ? secured(jsonError(503, "registry unavailable"))
            : secured(jsonError(500, "internal error"));
        }),
      ),
    ),
  );

/**
 * One bot's share of a scheduled run, its failure logged under `what` rather
 * than failing the rest: one failing bot must not stop the others.
 */
const perBot = <A>(id: string, what: string, call: () => Promise<A>): Effect.Effect<void> =>
  Effect.tryPromise({ try: call, catch: (cause) => cause }).pipe(
    Effect.match({
      onSuccess: () => undefined,
      onFailure: (cause) => {
        console.error(`mackbot: ${what} for "${id}" failed: ${describeCause(cause)}`);
      },
    }),
  );

/**
 * The cron: every bot that declares a brief is sent it, and every bot drops
 * the audit rows, failures and settled approvals past their retention.
 */
export const handleScheduled = async (controller: ScheduledController, env: Env): Promise<void> => {
  const scheduledTime = controller.scheduledTime;
  const bots = await readRoster(env);
  const work: Effect.Effect<void>[] = [];
  for (const [id, bot] of Object.entries(bots)) {
    const stub = env.Bot.getByName(id);
    work.push(perBot(id, "retention prune", () => stub.prune()));
    const brief = bot.brief;
    if (brief === undefined) continue;
    work.push(
      perBot(id, "cron brief", () =>
        stub.submit(brief, cronOperationId(id, scheduledTime), "followUp"),
      ),
    );
  }
  await Effect.runPromise(Effect.all(work, { concurrency: "unbounded" }));
};
