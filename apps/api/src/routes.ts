/**
 * routes - the Worker's handlers, one per route.
 *
 * Every bot-scoped handler is called with a {@link BotScoped} request: the
 * router has already matched the path, checked the method and confirmed the
 * bot is in the roster, so a handler only decodes its input and calls the
 * bot. The registry's own routes (`/bots`, `/models`, `/status`) take the
 * environment alone.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  AbortRequestSchema,
  ApprovalDecisionSchema,
  BotCreateSchema,
  BotWriteSchema,
  CompactRequestSchema,
  RetryRequestSchema,
  TranscriptQuerySchema,
} from "@mackbot/contract";
import type { BotView } from "@mackbot/contract";
import { MODEL_VARIANTS } from "@mackbot/contract/catalog";

import type { Bot } from "./bot.ts";
import type { BotConfig } from "./bots.ts";
import { readChatRequest } from "./chat-request.ts";
import { LONG_POLL_TIMEOUT_MS } from "./constants.ts";
import type { Env } from "./env.ts";
import { describeCause, invalidBody, jsonError, readJsonBody } from "./http.ts";
import { PiIdSchema } from "./ids.ts";
import { httpOperationId } from "./operation.ts";
import type { RegistryWrite } from "./registry-store.ts";
import { makeManagedRuntime, type ManagedRuntime } from "./runtime.ts";
import { BotRegistryService } from "./services/bot-registry.ts";

/** One request to a route under a declared bot. */
export interface BotScoped {
  readonly request: Request;
  readonly url: URL;
  readonly botId: string;
  readonly bot: DurableObjectStub<Bot>;
  /** The route's path match: `path[1]` is the bot id, later groups are the route's own. */
  readonly path: RegExpExecArray;
}

/**
 * The registry runtime, one per environment.
 *
 * An isolate sees one `env` for its lifetime, so the layer is built once
 * rather than on every request; the map is weak so a replaced environment
 * takes its runtime with it.
 */
const registryRuntimes = new WeakMap<Env, ManagedRuntime<BotRegistryService>>();

const registryRuntime = (env: Env): ManagedRuntime<BotRegistryService> => {
  const existing = registryRuntimes.get(env);
  if (existing !== undefined) return existing;
  const created = makeManagedRuntime(BotRegistryService.layerFor(env));
  registryRuntimes.set(env, created);
  return created;
};

/**
 * The roster, read through the registry.
 *
 * The registry is the truth about who exists, so every route that asks
 * whether a bot is there asks the registry and not a module cache.
 */
export const readRoster = (env: Env): Promise<Record<string, BotConfig>> =>
  registryRuntime(env).runPromise(
    Effect.flatMap(BotRegistryService, (registry) => registry.roster()),
  );

/** The one write, through the registry. */
const writeBot = (
  env: Env,
  name: string,
  bot: BotConfig,
  mode: "create" | "replace",
): Promise<RegistryWrite> =>
  registryRuntime(env).runPromise(
    Effect.flatMap(BotRegistryService, (registry) => registry.write(name, bot, mode)),
  );

/**
 * The session-carrying bodies, with the session decoded as a pi id: a session
 * that cannot name a conversation is a bad request, not an internal error.
 */
const AbortBodySchema = Schema.Struct({
  ...AbortRequestSchema.fields,
  session: Schema.optional(PiIdSchema),
});

const CompactBodySchema = Schema.Struct({
  ...CompactRequestSchema.fields,
  session: Schema.optional(PiIdSchema),
});

const RetryBodySchema = Schema.Struct({ ...RetryRequestSchema.fields, taskId: PiIdSchema });

/** The bodies of the routes whose every field is optional: empty means "the defaults". */
const EMPTY_OBJECT = "{}";

export const handleChat = async ({ request, url, bot }: BotScoped): Promise<Response> => {
  const body = await readChatRequest(request);
  if (body === undefined) return invalidBody();
  const operationId = httpOperationId(body.operationId);
  const receipt = await Effect.runPromise(
    Effect.tryPromise(() =>
      bot.submit(body.text, operationId, body.whenBusy ?? "followUp", body.thread),
    ),
  );
  // `wait=false` returns here; to fetch the result later, POST the same
  // operationId again (admission is at-most-once) and let it long-poll.
  if (url.searchParams.get("wait") === "0" || body.wait === false) {
    return Response.json(
      { operationId: receipt.operationId, accepted: receipt.accepted },
      { status: 202 },
    );
  }
  const result = await Effect.runPromise(
    Effect.tryPromise(() => bot.wait(operationId, LONG_POLL_TIMEOUT_MS, receipt.session)),
  );
  if (result.status === "timeout") {
    return Response.json(
      { operationId, accepted: receipt.accepted, status: result.status },
      { status: 202 },
    );
  }
  return Response.json(result, { status: 200 });
};

/**
 * One bot's Server-Sent Events stream. The stream's resume cursor lives in
 * `Last-Event-ID` / `?from=`, so the request reaches `sseResponse` intact
 * through the DO's own `fetch`.
 */
export const handleEvents = async ({ request, bot }: BotScoped): Promise<Response> =>
  await bot.fetch(request);

export const handleTranscript = async ({ url, bot }: BotScoped): Promise<Response> => {
  const query = await Effect.runPromise(
    Schema.decodeUnknownEffect(TranscriptQuerySchema)(Object.fromEntries(url.searchParams)).pipe(
      Effect.orElseSucceed(() => undefined),
    ),
  );
  if (query === undefined) return jsonError(400, "invalid query");
  const page = await Effect.runPromise(Effect.tryPromise(() => bot.transcript(query)));
  return Response.json(page);
};

/**
 * Decide one pending approval. An undecodable body is not a decision, so it is
 * refused rather than read as a partial one.
 */
export const handleApproval = async ({ request, bot, path }: BotScoped): Promise<Response> => {
  const decision = await readJsonBody(request, ApprovalDecisionSchema);
  if (decision === undefined) return invalidBody();
  const approvalId = path[2]!;
  const decided = await Effect.runPromise(
    Effect.tryPromise(() => bot.decide(approvalId, decision)),
  );
  if (decided === undefined) {
    // Already decided, unknown, or not resumable: the human's decision must not
    // be replayed into a second resume.
    return jsonError(409, "no pending approval");
  }
  return Response.json(decided);
};

/**
 * Stop a bot's current work. The body is optional: an empty body stops the
 * bot's root session.
 */
export const handleAbort = async ({ request, bot }: BotScoped): Promise<Response> => {
  const body = await readJsonBody(request, AbortBodySchema, EMPTY_OBJECT);
  if (body === undefined) return invalidBody();
  const result = await Effect.runPromise(Effect.tryPromise(() => bot.abort(body.session)));
  return Response.json(result);
};

/**
 * Run a parked task again. The harness parks a task that was cut off too many
 * times in a row, so a bot that was crashing in a loop can be given another
 * chance without waiting for the crash limit to expire.
 */
export const handleRetry = async ({ request, bot }: BotScoped): Promise<Response> => {
  const body = await readJsonBody(request, RetryBodySchema);
  if (body === undefined) return invalidBody();
  const result = await Effect.runPromise(Effect.tryPromise(() => bot.retry(body.taskId)));
  return Response.json(result);
};

/**
 * Compact a bot's conversation by hand. Every field is optional, so an empty
 * body compacts the root conversation. The summary is made in a task, so the
 * answer is that task's id: clients follow it through the feed and the status
 * view rather than waiting for the whole summary here.
 */
export const handleCompact = async ({ request, bot }: BotScoped): Promise<Response> => {
  const body = await readJsonBody(request, CompactBodySchema, EMPTY_OBJECT);
  if (body === undefined) return invalidBody();
  const result = await Effect.runPromise(
    Effect.tryPromise(() => bot.compact(body.session, body.instructions)),
  );
  return Response.json(result);
};

interface BotStatusResult {
  readonly id: string;
  readonly status?: BotView;
  readonly error?: string;
}

export const handleStatus = async (env: Env): Promise<Response> => {
  const bots = await readRoster(env);
  const statusFor = (id: string): Effect.Effect<BotStatusResult> =>
    Effect.tryPromise(() => env.Bot.getByName(id).status()).pipe(
      Effect.map((status): BotStatusResult => ({ id, status })),
      Effect.catch((cause): Effect.Effect<BotStatusResult> => {
        // Log the real cause; return a generic message so internal error
        // strings (URLs, RPC details) never reach the client.
        console.error(`mackbot: status for "${id}" failed: ${describeCause(cause)}`);
        return Effect.succeed({ id, error: "status unavailable" });
      }),
    );
  const results = await Effect.runPromise(
    Effect.all(Object.keys(bots).map(statusFor), { concurrency: "unbounded" }),
  );
  const statuses: Record<string, BotView> = {};
  const errors: Record<string, string> = {};
  for (const entry of results) {
    if (entry.status === undefined) {
      errors[entry.id] = entry.error ?? "unknown error";
    } else {
      statuses[entry.id] = entry.status;
    }
  }
  return Response.json({ bots: statuses, errors });
};

/** The roster: every bot the fleet runs, as the browser edits it. */
export const handleRoster = async (env: Env): Promise<Response> =>
  Response.json({ bots: await readRoster(env) });

/**
 * The models the Worker knows, and the thinking levels each one supports.
 *
 * The catalog lives in the Worker, so it crosses the wire rather than
 * reaching the browser's module graph: the browser offers a picker, and the
 * Worker is what knows which models exist.
 */
export const handleModels = (): Response => Response.json({ models: MODEL_VARIANTS });

const WRITE_REFUSAL_STATUS: Record<(RegistryWrite & { readonly ok: false })["code"], number> = {
  invalid: 400,
  unknown: 404,
  exists: 409,
};

/**
 * A refused write, in the status code its refusal means: a rule's own message
 * for a bot that breaks a rule, a 404 for a bot that is not there and a 409
 * for one that already is.
 */
const writeRefusal = (refusal: RegistryWrite & { readonly ok: false }): Response =>
  jsonError(WRITE_REFUSAL_STATUS[refusal.code], refusal.error);

/**
 * Add a bot. The body carries the id to give the new bot and the whole
 * configuration it runs with; a body that does not decode never reaches the
 * registry.
 */
export const handleBotCreate = async (request: Request, env: Env): Promise<Response> => {
  const body = await readJsonBody(request, BotCreateSchema);
  if (body === undefined) return invalidBody();
  const result = await writeBot(env, body.id, body.bot, "create");
  if (!result.ok) return writeRefusal(result);
  return Response.json({ id: body.id, bot: result.roster[body.id] }, { status: 201 });
};

/**
 * Replace a bot's configuration. The body carries the whole configuration, so
 * the fields the form does not show survive the round trip.
 */
export const handleBotWrite = async (
  request: Request,
  env: Env,
  botId: string,
): Promise<Response> => {
  const body = await readJsonBody(request, BotWriteSchema);
  if (body === undefined) return invalidBody();
  const result = await writeBot(env, botId, body.bot, "replace");
  if (!result.ok) return writeRefusal(result);
  return Response.json({ id: botId, bot: result.roster[botId] });
};
