/**
 * mackbot — the front door Worker and the `Bot` Durable Object.
 */

import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { PiHarness, ROOT_SESSION } from "agents/harness/pi";
import type { PiHarnessFactory, PiReceipt, PiWhenBusy } from "agents/harness/pi";
import { createAI } from "agents/models/pi-ai";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import type { AgentChange, ConversationId, HarnessSettings, UsageState } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createExecutorMcp } from "./executor-mcp.ts";
import { createBotDelegation } from "./bot-delegation.ts";
import { getBot, loadBots, resolveModelRef } from "./bots.ts";
import type { ModelRef, ThinkingLevel } from "./bots.ts";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface Env {
  readonly Bot: DurableObjectNamespace<Bot>;
  readonly AI: Ai;
  readonly EXECUTOR_URL: string;
  readonly EXECUTOR_TOKEN: string;
  readonly OPENCODE_API_KEY: string;
  readonly CHAT_BEARER_TOKEN: string;
}

export interface PendingOperation {
  readonly operationId: string;
  readonly status: "queued" | "running";
}

export interface BotStatus {
  readonly id: string;
  readonly model: ModelRef;
  readonly thinkingLevel: ThinkingLevel | null;
  readonly busy: boolean;
  readonly pending: readonly PendingOperation[];
  readonly usage: UsageState;
}

export interface WaitResult {
  readonly operationId: string;
  readonly session: string;
  readonly status: "done" | "unanswered" | "timeout";
  readonly text?: string;
  readonly reason?: string;
}

const LONG_POLL_TIMEOUT_MS = 55_000;

const HARNESS_SETTINGS: HarnessSettings = {
  progress: { partialIntervalMs: 1_000, outputIntervalMs: 1_000 },
  compaction: { enabled: true, reserveTokens: 16_384 },
};

const toThinkingLevel = (level: ThinkingLevel): ModelThinkingLevel =>
  level === "none" ? "off" : level;

const makeHarnessFactory =
  (env: Env, botId: string): PiHarnessFactory =>
  async ({ storage, context }) => {
    const registry = createRegistry();
    registry.install(createExecutorMcp({ url: env.EXECUTOR_URL, token: env.EXECUTOR_TOKEN }));
    registry.install(createBotDelegation({ env, sourceBotId: botId }));
    const models = createModels();
    models.setProvider(opencodeGoProvider());
    models.setProvider(createAI({ binding: env.AI }).provider);
    return Harness.open(storage, { models, registry, settings: HARNESS_SETTINGS }, context);
  };

export class Bot extends DurableObject<Env> {
  readonly lifecycle: Lifecycle<Env>;
  readonly harness: PiHarness;
  #botReady: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle = Lifecycle.install(this);
    this.harness = new PiHarness({ harness: makeHarnessFactory(env, this.lifecycle.name) });
    this.lifecycle.use(this.harness);
  }

  async submit(
    text: string,
    operationId: string,
    whenBusy: PiWhenBusy,
    thread?: string,
  ): Promise<PiReceipt> {
    await Effect.runPromise(Effect.tryPromise(() => this.lifecycle.start()));
    const sessionId =
      thread === undefined ? ROOT_SESSION : await Effect.runPromise(Effect.tryPromise(() => this.#sessionForThread(thread)));
    if (thread === undefined) await Effect.runPromise(Effect.tryPromise(() => this.#ensureBot()));
    return Effect.runPromise(
      Effect.tryPromise(() => this.harness.submit(text, { operationId, whenBusy, session: sessionId })),
    );
  }

  async wait(operationId: string, timeoutMs: number, session: string = ROOT_SESSION): Promise<WaitResult> {
    await Effect.runPromise(Effect.tryPromise(() => this.lifecycle.start()));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const outcome = await Effect.runPromise(
      Effect.tryPromise(() => this.harness.wait(operationId, { session, signal: controller.signal })).pipe(
        Effect.match({
          onSuccess: (result) => ({ kind: "ok" as const, result }),
          onFailure: (cause) =>
            controller.signal.aborted ? { kind: "timeout" as const } : { kind: "fail" as const, cause },
        }),
      ),
    );
    clearTimeout(timer);
    if (outcome.kind === "timeout") {
      return { operationId, session, status: "timeout" };
    }
    if (outcome.kind === "fail") {
      throw outcome.cause;
    }
    const result = outcome.result;
    return {
      operationId: result.operationId,
      session: result.session,
      status: result.status,
      text: result.text,
      reason: result.reason,
    };
  }

  async status(): Promise<BotStatus> {
    await Effect.runPromise(Effect.tryPromise(() => this.lifecycle.start()));
    const id = this.lifecycle.name;
    const bot = getBot(id);
    const [busy, pending, usage] = await Effect.runPromise(
      Effect.all(
        [
          Effect.tryPromise(() => this.harness.session(ROOT_SESSION).busy()),
          Effect.tryPromise(() => this.harness.pending()),
          Effect.tryPromise(() => this.#usage()),
        ],
        { concurrency: "unbounded" },
      ),
    );
    return {
      id,
      model: resolveModelRef(bot),
      thinkingLevel: bot.thinkingLevel ?? null,
      busy,
      pending: pending.map((operation) => ({
        operationId: operation.operationId,
        status: operation.status,
      })),
      usage,
    };
  }

  #ensureThreadsTable(): void {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS mackbot_threads (thread TEXT PRIMARY KEY, session_id TEXT NOT NULL)",
    );
  }

  async #sessionForThread(thread: string): Promise<string> {
    this.#ensureThreadsTable();
    const rows = this.ctx.storage.sql
      .exec("SELECT session_id FROM mackbot_threads WHERE thread = ?", thread)
      .toArray();
    if (rows.length > 0) {
      return String(rows[0].session_id);
    }
    await Effect.runPromise(Effect.tryPromise(() => this.#ensureBot()));
    const session = await Effect.runPromise(Effect.tryPromise(() => this.harness.sessions.create()));
    const sessionId = session.id;
    const bot = getBot(this.lifecycle.name);
    await Effect.runPromise(Effect.tryPromise(() => this.#configureSession(sessionId, bot)));
    this.ctx.storage.sql.exec(
      "INSERT INTO mackbot_threads (thread, session_id) VALUES (?, ?)",
      thread,
      sessionId,
    );
    return sessionId;
  }

  async #configureSession(sessionId: string, bot: ReturnType<typeof getBot>): Promise<void> {
    const model = resolveModelRef(bot);
    const pi = await Effect.runPromise(Effect.tryPromise(() => this.harness.pi()));
    const conversation = await Effect.runPromise(
      // SAFETY: PiSession ids are numeric strings; cast to pi-durable's numeric ConversationId.
      Effect.tryPromise(() => pi.conversation(Number(sessionId) as ConversationId, BACKGROUND_CONTEXT)),
    );
    if (conversation === undefined) {
      throw new Error(`session ${sessionId} not found`);
    }
    const thinkingLevel = bot.thinkingLevel;
    const change: AgentChange =
      thinkingLevel === undefined
        ? {
            model: { provider: model.provider, modelId: model.id },
            instructions: bot.systemPrompt,
          }
        : {
            model: { provider: model.provider, modelId: model.id },
            thinkingLevel: toThinkingLevel(thinkingLevel),
            instructions: bot.systemPrompt,
          };
    await Effect.runPromise(Effect.tryPromise(() => conversation.configure(change, BACKGROUND_CONTEXT)));
  }

  #ensureBot(): Promise<void> {
    const ready = (this.#botReady ??= this.#applyBot());
    return ready;
  }

  async #applyBot(): Promise<void> {
    const bot = getBot(this.lifecycle.name);
    const model = resolveModelRef(bot);
    const pi = await Effect.runPromise(Effect.tryPromise(() => this.harness.pi()));
    const root = await Effect.runPromise(Effect.tryPromise(() => pi.root(BACKGROUND_CONTEXT)));
    const thinkingLevel = bot.thinkingLevel;
    const change: AgentChange =
      thinkingLevel === undefined
        ? {
            model: { provider: model.provider, modelId: model.id },
            instructions: bot.systemPrompt,
          }
        : {
            model: { provider: model.provider, modelId: model.id },
            thinkingLevel: toThinkingLevel(thinkingLevel),
            instructions: bot.systemPrompt,
          };
    await Effect.runPromise(Effect.tryPromise(() => root.configure(change, BACKGROUND_CONTEXT)));
  }

  async #usage(): Promise<UsageState> {
    const pi = await Effect.runPromise(Effect.tryPromise(() => this.harness.pi()));
    return Effect.runPromise(Effect.tryPromise(() => pi.usage(BACKGROUND_CONTEXT)));
  }
}

interface ChatRequest {
  readonly text: string;
  readonly operationId?: string;
  readonly whenBusy?: PiWhenBusy;
  readonly wait?: boolean;
  readonly conversation?: string;
  readonly thread?: string;
}

interface DraftChatRequest {
  text: string;
  operationId?: string;
  whenBusy?: PiWhenBusy;
  wait?: boolean;
  conversation?: string;
  thread?: string;
}

const trimmedNonEmpty = Schema.String.check(Schema.makeFilter((input: string) => input.trim().length > 0));

const ChatRequestBodySchema = Schema.Struct({
  text: trimmedNonEmpty,
  operationId: Schema.optional(Schema.NonEmptyString),
  whenBusy: Schema.optional(Schema.Literals(["followUp", "steer"])),
  wait: Schema.optional(Schema.Boolean),
  conversation: Schema.optional(trimmedNonEmpty),
  thread: Schema.optional(trimmedNonEmpty),
});

const BEARER_PATTERN = /^Bearer\s+(.+)$/u;

const isAuthorized = (request: Request, env: Env): boolean => {
  const header = request.headers.get("Authorization");
  if (header === null) return false;
  const token = BEARER_PATTERN.exec(header)?.[1];
  return token !== undefined && token === env.CHAT_BEARER_TOKEN;
};

const CHAT_ROUTE = /^\/chat\/([^/]+)$/u;

const methodNotAllowed = (): Response =>
  Response.json({ error: "method not allowed" }, { status: 405 });

const readChatRequest = async (request: Request): Promise<ChatRequest | undefined> => {
  const effect = Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({ try: () => request.json(), catch: () => "bad json" });
    const decoded = yield* Schema.decodeUnknownEffect(ChatRequestBodySchema)(raw).pipe(
      Effect.mapError(() => "bad body"),
    );
    const body: DraftChatRequest = { text: decoded.text };
    if (decoded.operationId !== undefined) body.operationId = decoded.operationId;
    if (decoded.whenBusy !== undefined) body.whenBusy = decoded.whenBusy;
    if (decoded.wait !== undefined) body.wait = decoded.wait;
    if (decoded.conversation !== undefined) body.conversation = decoded.conversation;
    if (decoded.thread !== undefined) body.thread = decoded.thread;
    return body;
  });
  // SAFETY: the generator requires R=unknown, but Effect.runPromise needs R=never; the code uses no runtime services.
  return Effect.runPromise(effect as Effect.Effect<DraftChatRequest, unknown, never>).catch(() => undefined);
};

const handleChat = async (
  request: Request,
  env: Env,
  botId: string,
  immediate: boolean,
): Promise<Response> => {
  const bots = loadBots();
  if (!Object.hasOwn(bots, botId)) {
    return Response.json({ error: `unknown bot "${botId}"` }, { status: 404 });
  }
  const body = await readChatRequest(request);
  if (body === undefined) {
    return Response.json({ error: "invalid request body" }, { status: 400 });
  }
  const operationId = body.operationId ?? `http:${crypto.randomUUID()}`;
  const thread = body.conversation ?? body.thread;
  const stub = env.Bot.getByName(botId);
  const receipt = await Effect.runPromise(
    Effect.tryPromise(() => stub.submit(body.text, operationId, body.whenBusy ?? "followUp", thread)),
  );
  if (immediate || body.wait === false) {
    return Response.json(
      { operationId: receipt.operationId, accepted: receipt.accepted },
      { status: 202 },
    );
  }
  const result = await Effect.runPromise(
    Effect.tryPromise(() => stub.wait(operationId, LONG_POLL_TIMEOUT_MS, receipt.session)),
  );
  if (result.status === "timeout") {
    return Response.json(
      { operationId, accepted: receipt.accepted, status: result.status },
      { status: 202 },
    );
  }
  return Response.json(result, { status: 200 });
};

const handleStatus = async (env: Env): Promise<Response> => {
  const bots = loadBots();
  const statuses = await Effect.runPromise(
    Effect.all(
      Object.keys(bots).map((id) =>
        Effect.map(Effect.tryPromise(() => env.Bot.getByName(id).status()), (status) => [id, status] as const),
      ),
      { concurrency: "unbounded" },
    ),
  );
  return Response.json({ bots: Object.fromEntries(statuses) });
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!isAuthorized(request, env)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = new URL(request.url);
    if (url.pathname === "/status") {
      return request.method === "GET" ? handleStatus(env) : methodNotAllowed();
    }
    const match = CHAT_ROUTE.exec(url.pathname);
    if (match !== null) {
      return request.method === "POST"
        ? handleChat(request, env, match[1]!, url.searchParams.get("wait") === "0")
        : methodNotAllowed();
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const scheduledTime = controller.scheduledTime;
    const bots = loadBots();
    const admissions: Effect.Effect<PiReceipt, unknown>[] = [];
    for (const [id, bot] of Object.entries(bots)) {
      const brief = bot.brief;
      if (brief === undefined) continue;
      admissions.push(
        Effect.tryPromise(() => env.Bot.getByName(id).submit(brief, `cron:${id}:${scheduledTime}`, "followUp")),
      );
    }
    await Effect.runPromise(Effect.all(admissions, { concurrency: "unbounded" }));
  },
};