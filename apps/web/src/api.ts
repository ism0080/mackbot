import {
  AbortResultSchema,
  BotConfigSchema,
  BotIdSchema,
  BotViewSchema,
  BotWriteResultSchema,
  ModelCatalogSchema,
  RetryResultSchema,
  RosterSchema,
  TranscriptPageSchema,
} from "@mackbot/contract";
import type { AbortRequest, BotCreate, BotWrite } from "@mackbot/contract";
import type { ApprovalDecision } from "@mackbot/contract";
import { Clock, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { Command, Http } from "foldkit";
import { load } from "foldkit/navigation";

import { Message } from "./message.ts";
import { retryRequest, retryRoute } from "./task-retry.ts";

/**
 * The Commands that are the app's whole data source. Each one decodes its
 * response against the contract's Schema, so a route that drifts from the
 * vocabulary fails at the boundary rather than rendering a half-built view.
 */

/** The transcript page size the app asks for; the route clamps it to 200. */
export const TRANSCRIPT_LIMIT = 50;

/**
 * `/status`'s envelope: one view per bot that answered, plus the bots whose
 * status could not be read. The per-bot `BotView` is the contract's; the
 * envelope wrapping it is this route's shape.
 */
const StatusResponseSchema = Schema.Struct({
  bots: Schema.Record(Schema.String, BotViewSchema),
  errors: Schema.Record(Schema.String, Schema.String),
});

/**
 * The Worker origin. The Worker serves this app, so every route is same-origin:
 * the browser surface authenticates with a session cookie — `EventSource`
 * cannot set an `Authorization` header — and the write routes check `Origin`,
 * so a split deployment would need neither to hold. No token is bundled; the
 * bearer never leaves the machine.
 */
export const apiUrl = (path: string): string => `${globalThis.location.origin}${path}`;

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const Status = Command.define("Status", {
  messages: [Message.StatusLoaded, Message.StatusFailed],
  execute: Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const response = yield* client.get(apiUrl("/status"));
    const { bots, errors } =
      yield* HttpClientResponse.schemaBodyJson(StatusResponseSchema)(response);
    return Message.StatusLoaded({ bots, errors, at: yield* Clock.currentTimeMillis });
  }).pipe(
    Effect.catch((cause) =>
      Effect.map(Clock.currentTimeMillis, (at) =>
        Message.StatusFailed({ error: describe(cause), at }),
      ),
    ),
    Effect.provide(Http.layer),
  ),
});

export const Transcript = Command.define("Transcript", {
  args: { bot: Schema.String, before: Schema.optional(Schema.Number) },
  messages: [Message.TranscriptLoaded, Message.TranscriptFailed],
  execute: ({ bot, before }) =>
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      const query =
        before === undefined
          ? `?limit=${TRANSCRIPT_LIMIT}`
          : `?limit=${TRANSCRIPT_LIMIT}&before=${before}`;
      const response = yield* client.get(apiUrl(`/transcript/${encodeURIComponent(bot)}${query}`));
      const page = yield* HttpClientResponse.schemaBodyJson(TranscriptPageSchema)(response);
      return Message.TranscriptLoaded({ bot, page, before });
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed(Message.TranscriptFailed({ bot, error: describe(cause), before })),
      ),
      Effect.provide(Http.layer),
    ),
});

/**
 * The decision route's own response shapes, not the contract's: the route is the
 * server's and serves the four fields the store wrote, then `{ error }` when the
 * approval was not pending. A browser must decode the shape it is actually
 * served, so these live here as the route's shape rather than as a contract type.
 */
const DecisionAcceptedSchema = Schema.Struct({
  approvalId: Schema.String,
  bot: Schema.String,
  status: Schema.Literals(["allowed", "denied"]),
  decidedAt: Schema.Number,
});

/**
 * A refusal's own shape: `{ error }`, carrying the rule's words. The decision
 * route answers it when the approval was not pending, and the write routes
 * answer it when a rule refused the write.
 */
const RefusedSchema = Schema.Struct({ error: Schema.String });

/**
 * The roster the registry holds: one configuration per bot, keyed by bot id.
 * The route answers the contract's `RosterSchema`, so the browser decodes it
 * with the contract's schema rather than a private copy of the shape.
 */
export const Roster = Command.define("Roster", {
  messages: [Message.RosterLoaded, Message.RosterFailed],
  execute: Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const response = yield* client.get(apiUrl("/bots"));
    const roster = yield* HttpClientResponse.schemaBodyJson(RosterSchema)(response);
    return Message.RosterLoaded({ roster });
  }).pipe(
    Effect.catch((cause) => Effect.succeed(Message.RosterFailed({ error: describe(cause) }))),
    Effect.provide(Http.layer),
  ),
});

/**
 * The model catalog: the models the Worker knows, and the thinking levels each
 * one supports. The Worker owns it, so it crosses the wire rather than being
 * bundled into the browser.
 */
export const Catalog = Command.define("Catalog", {
  messages: [Message.CatalogLoaded, Message.CatalogFailed],
  execute: Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const response = yield* client.get(apiUrl("/models"));
    const catalog = yield* HttpClientResponse.schemaBodyJson(ModelCatalogSchema)(response);
    return Message.CatalogLoaded({ catalog });
  }).pipe(
    Effect.catch((cause) => Effect.succeed(Message.CatalogFailed({ error: describe(cause) }))),
    Effect.provide(Http.layer),
  ),
});

/**
 * The refusal the routes answer a write with: `400 { error }`, carrying the
 * rule's own words. It is read rather than turned into a decode error, so the
 * person is told what the rule said instead of what the status code was.
 */
const refusalOf = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<string, never, never> =>
  HttpClientResponse.schemaBodyJson(RefusedSchema)(response).pipe(
    Effect.map((body) => body.error),
    Effect.catch(() => Effect.succeed(`the write route answered ${response.status}`)),
  );

/**
 * `POST /chat/:bot`'s accepted answer: the operation the server recorded, and
 * whether it admitted it. `wait=0` asks for the receipt immediately rather than
 * holding the request open for the run's result; the transcript and its SSE
 * stream are how the answer arrives.
 */
const ChatAcceptedSchema = Schema.Struct({
  operationId: Schema.String,
  accepted: Schema.Boolean,
});

/**
 * `POST /chat/:bot` with the text the composer holds. This is the app's one
 * route that starts work instead of observing it.
 */
export const Chat = Command.define("Chat", {
  args: { bot: Schema.String, text: Schema.String },
  messages: [Message.ChatSent, Message.ChatFailed],
  execute: ({ bot, text }) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const request = yield* HttpClientRequest.post(
        apiUrl(`/chat/${encodeURIComponent(bot)}?wait=0`),
      ).pipe(
        // Cookie authentication is in play here; the server requires this
        // header's presence as proof the request came from a same-origin fetch.
        HttpClientRequest.setHeader("X-Mackbot-CSRF", "1"),
        HttpClientRequest.bodyJson({ text }),
      );
      const response = yield* client.execute(request);
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(yield* refusalOf(response));
      }
      const accepted = yield* HttpClientResponse.schemaBodyJson(ChatAcceptedSchema)(response);
      return Message.ChatSent({ bot, operationId: accepted.operationId });
    }).pipe(
      Effect.catch((cause) => Effect.succeed(Message.ChatFailed({ bot, error: describe(cause) }))),
      Effect.provide(Http.layer),
    ),
});

/**
 * `PUT /bots/:id` with the contract's write body. The whole configuration of
 * the bot is sent, so the fields the form does not show survive the round
 * trip.
 */
export const SaveBot = Command.define("SaveBot", {
  args: { bot: Schema.String, config: BotConfigSchema },
  messages: [Message.BotSaved, Message.BotSaveFailed],
  execute: ({ bot, config }) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const request = yield* HttpClientRequest.put(apiUrl(`/bots/${encodeURIComponent(bot)}`)).pipe(
        // Cookie authentication is in play here; the server requires this
        // header's presence as proof the request came from a same-origin fetch.
        HttpClientRequest.setHeader("X-Mackbot-CSRF", "1"),
        HttpClientRequest.bodyJson({ bot: config } satisfies BotWrite),
      );
      const response = yield* client.execute(request);
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(yield* refusalOf(response));
      }
      const written = yield* HttpClientResponse.schemaBodyJson(BotWriteResultSchema)(response);
      return Message.BotSaved({ id: written.id, bot: written.bot });
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed(Message.BotSaveFailed({ bot, error: describe(cause) })),
      ),
      Effect.provide(Http.layer),
    ),
});

/**
 * `POST /bots` with the contract's create body: the id to give the new bot and
 * its configuration.
 */
export const CreateBot = Command.define("CreateBot", {
  args: { id: BotIdSchema, bot: BotConfigSchema },
  messages: [Message.BotCreated, Message.BotCreateFailed],
  execute: ({ id, bot }) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const request = yield* HttpClientRequest.post(apiUrl("/bots")).pipe(
        // Cookie authentication is in play here; the server requires this
        // header's presence as proof the request came from a same-origin fetch.
        HttpClientRequest.setHeader("X-Mackbot-CSRF", "1"),
        HttpClientRequest.bodyJson({ id, bot } satisfies BotCreate),
      );
      const response = yield* client.execute(request);
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(yield* refusalOf(response));
      }
      const created = yield* HttpClientResponse.schemaBodyJson(BotWriteResultSchema)(response);
      return Message.BotCreated({ id: created.id, bot: created.bot });
    }).pipe(
      Effect.catch((cause) => Effect.succeed(Message.BotCreateFailed({ error: describe(cause) }))),
      Effect.provide(Http.layer),
    ),
});

/**
 * `POST /abort/:bot` with the contract's abort body. The route answers the
 * contract's `AbortResult`, so it decodes with the contract's schema rather
 * than a private copy of the route's shape.
 */
export const StopBot = Command.define("StopBot", {
  args: { bot: Schema.String, session: Schema.String },
  messages: [Message.StoppedBot, Message.StopFailed],
  execute: ({ bot, session }) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const request = yield* HttpClientRequest.post(
        apiUrl(`/abort/${encodeURIComponent(bot)}`),
      ).pipe(
        // Cookie authentication is in play here; the server requires this
        // header's presence as proof the request came from a same-origin fetch.
        HttpClientRequest.setHeader("X-Mackbot-CSRF", "1"),
        HttpClientRequest.bodyJson({ session } satisfies AbortRequest),
      );
      const response = yield* client.execute(request);
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(`the stop route answered ${response.status}`);
      }
      const stopped = yield* HttpClientResponse.schemaBodyJson(AbortResultSchema)(response);
      return Message.StoppedBot({
        bot: stopped.bot,
        session: stopped.session,
        aborted: stopped.aborted,
      });
    }).pipe(
      Effect.catch((cause) => Effect.succeed(Message.StopFailed({ bot, error: describe(cause) }))),
      Effect.provide(Http.layer),
    ),
});
/**
 * `POST /approvals/:bot/:approvalId` with the contract's decision body. A `409`
 * is not a transport failure: it is the honest answer that the approval was not
 * pending, so this reads the refusal body rather than turning it into a decode
 * error the rollback path would claim as this client's failure.
 */
export const DecideApproval = Command.define("DecideApproval", {
  args: {
    bot: Schema.String,
    approvalId: Schema.String,
    action: Schema.Literals(["allow", "deny"]),
  },
  messages: [Message.ApprovalDecided, Message.ApprovalRefused, Message.ApprovalFailed],
  execute: ({ bot, approvalId, action }) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const request = yield* HttpClientRequest.post(
        apiUrl(`/approvals/${encodeURIComponent(bot)}/${encodeURIComponent(approvalId)}`),
      ).pipe(
        // Cookie authentication is in play here; the server requires this
        // header's presence as proof the request came from a same-origin fetch.
        HttpClientRequest.setHeader("X-Mackbot-CSRF", "1"),
        HttpClientRequest.bodyJson({ action } satisfies ApprovalDecision),
      );
      const response = yield* client.execute(request);

      if (response.status === 409) {
        yield* HttpClientResponse.schemaBodyJson(RefusedSchema)(response);
        return Message.ApprovalRefused({ bot, approvalId });
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(`the decision route answered ${response.status}`);
      }
      const decided = yield* HttpClientResponse.schemaBodyJson(DecisionAcceptedSchema)(response);
      return Message.ApprovalDecided({
        bot,
        approvalId: decided.approvalId,
        status: decided.status,
        decidedAt: decided.decidedAt,
      });
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed(Message.ApprovalFailed({ bot, approvalId, error: describe(cause) })),
      ),
      Effect.provide(Http.layer),
    ),
});

/**
 * `POST /retry/:bot` with the contract's retry body. The route runs a task the
 * harness parked, so the answer says whether it did: a task that was not
 * parked any more is answered `retried: false` rather than as a failure.
 */
export const RetryTask = Command.define("RetryTask", {
  args: { bot: Schema.String, taskId: Schema.String },
  messages: [Message.TaskRetried, Message.RetryFailed],
  execute: ({ bot, taskId }) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const request = yield* HttpClientRequest.post(apiUrl(retryRoute(bot))).pipe(
        // Cookie authentication is in play here; the server requires this
        // header's presence as proof the request came from a same-origin fetch.
        HttpClientRequest.setHeader("X-Mackbot-CSRF", "1"),
        HttpClientRequest.bodyJson(retryRequest(taskId)),
      );
      const response = yield* client.execute(request);
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(`the retry route answered ${response.status}`);
      }
      const retried = yield* HttpClientResponse.schemaBodyJson(RetryResultSchema)(response);
      return Message.TaskRetried({
        bot: retried.bot,
        taskId: retried.taskId,
        retried: retried.retried,
      });
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed(Message.RetryFailed({ bot, taskId, error: describe(cause) })),
      ),
      Effect.provide(Http.layer),
    ),
});

/**
 * `POST /logout`, then a full load of the login page. The session cookie is
 * `HttpOnly`, so only the server can clear it; once it has, nothing this app
 * holds is worth keeping, so the page is replaced rather than re-rendered.
 */
export const SignOut = Command.define("SignOut", {
  messages: [Message.SignedOut, Message.SignOutFailed],
  execute: Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(apiUrl("/logout")).pipe(
      // Cookie authentication is in play here; the server requires this
      // header's presence as proof the request came from a same-origin fetch.
      HttpClientRequest.setHeader("X-Mackbot-CSRF", "1"),
    );
    const response = yield* client.execute(request);
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(`the sign-out route answered ${response.status}`);
    }
    yield* load("/login");
    return Message.SignedOut();
  }).pipe(
    Effect.catch((cause) => Effect.succeed(Message.SignOutFailed({ error: describe(cause) }))),
    Effect.provide(Http.layer),
  ),
});
