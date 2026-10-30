import {
  AbortResultSchema,
  BotConfigSchema,
  BotIdSchema,
  BotWriteResultSchema,
  ChatAcceptedSchema,
  DecisionAcceptedSchema,
  ErrorBodySchema,
  ModelCatalogSchema,
  RetryResultSchema,
  RosterSchema,
  StatusResponseSchema,
  ThreadListSchema,
  ThreadViewSchema,
  TranscriptPageSchema,
} from "@mackbot/contract";
import type { AbortRequest, BotCreate, BotWrite, ThreadUpdate } from "@mackbot/contract";
import type { ApprovalDecision } from "@mackbot/contract";
import { Clock, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { Command, Http } from "foldkit";
import { load } from "foldkit/navigation";

import { threadField } from "./channel.ts";
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

/**
 * One page of a conversation's transcript. `thread` names the conversation;
 * absent is the bot's main one.
 */
export const Transcript = Command.define("Transcript", {
  args: {
    bot: Schema.String,
    thread: Schema.optional(Schema.String),
    before: Schema.optional(Schema.Number),
  },
  messages: [Message.TranscriptLoaded, Message.TranscriptFailed],
  execute: ({ bot, thread, before }) =>
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      const query = new URLSearchParams({
        limit: String(TRANSCRIPT_LIMIT),
        ...threadField(thread),
        ...(before === undefined ? {} : { before: String(before) }),
      });
      const response = yield* client.get(
        apiUrl(`/transcript/${encodeURIComponent(bot)}?${query.toString()}`),
      );
      const page = yield* HttpClientResponse.schemaBodyJson(TranscriptPageSchema)(response);
      return Message.TranscriptLoaded({ bot, ...threadField(thread), page, before });
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed(
          Message.TranscriptFailed({ bot, ...threadField(thread), error: describe(cause), before }),
        ),
      ),
      Effect.provide(Http.layer),
    ),
});

/** The bot's conversations: its main one, then every thread it has not archived. */
export const Threads = Command.define("Threads", {
  args: { bot: Schema.String },
  messages: [Message.ThreadsLoaded, Message.ThreadsFailed],
  execute: ({ bot }) =>
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      const response = yield* client.get(apiUrl(`/threads/${encodeURIComponent(bot)}`));
      const threads = yield* HttpClientResponse.schemaBodyJson(ThreadListSchema)(response);
      return Message.ThreadsLoaded({ bot, threads });
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed(Message.ThreadsFailed({ bot, error: describe(cause) })),
      ),
      Effect.provide(Http.layer),
    ),
});

/**
 * The bot's conversations with the archived ones included, for the screen that
 * lists what was put away. The route answers every conversation, so the screen
 * picks the archived ones out of it.
 */
export const ArchivedThreads = Command.define("ArchivedThreads", {
  args: { bot: Schema.String },
  messages: [Message.ArchivedThreadsLoaded, Message.ArchivedThreadsFailed],
  execute: ({ bot }) =>
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      const response = yield* client.get(
        apiUrl(`/threads/${encodeURIComponent(bot)}?include=archived`),
      );
      const threads = yield* HttpClientResponse.schemaBodyJson(ThreadListSchema)(response);
      return Message.ArchivedThreadsLoaded({ bot, threads });
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed(Message.ArchivedThreadsFailed({ bot, error: describe(cause) })),
      ),
      Effect.provide(Http.layer),
    ),
});

/**
 * A new conversation's id. The server creates the conversation with its first
 * message, so starting one only mints the name the URL and the chat route
 * carry; it comes from the CSPRNG because it ends up in a shareable link.
 */
export const StartThread = Command.define("StartThread", {
  args: { bot: Schema.String },
  messages: [Message.ThreadStarted],
  execute: ({ bot }) =>
    Effect.sync(() => Message.ThreadStarted({ bot, thread: crypto.randomUUID() })),
});

/**
 * `POST /threads/:bot/:thread` archiving the conversation. A conversation
 * cannot be deleted, so this takes it out of the bot's list and leaves its
 * history reachable by its link.
 */
export const ArchiveThread = Command.define("ArchiveThread", {
  args: { bot: Schema.String, thread: Schema.String },
  messages: [Message.ThreadArchived, Message.ArchiveFailed],
  execute: ({ bot, thread }) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const request = yield* HttpClientRequest.post(
        apiUrl(`/threads/${encodeURIComponent(bot)}/${encodeURIComponent(thread)}`),
      ).pipe(
        // Cookie authentication is in play here; the server requires this
        // header's presence as proof the request came from a same-origin fetch.
        HttpClientRequest.setHeader("X-Mackbot-CSRF", "1"),
        HttpClientRequest.bodyJson({ archived: true } satisfies ThreadUpdate),
      );
      const response = yield* client.execute(request);
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(yield* refusalOf(response));
      }
      yield* HttpClientResponse.schemaBodyJson(ThreadViewSchema)(response);
      return Message.ThreadArchived({ bot, thread });
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed(Message.ArchiveFailed({ bot, thread, error: describe(cause) })),
      ),
      Effect.provide(Http.layer),
    ),
});

/**
 * `POST /threads/:bot/:thread` restoring an archived conversation, which puts
 * it back in the bot's list.
 */
export const RestoreThread = Command.define("RestoreThread", {
  args: { bot: Schema.String, thread: Schema.String },
  messages: [Message.ThreadRestored, Message.RestoreFailed],
  execute: ({ bot, thread }) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const request = yield* HttpClientRequest.post(
        apiUrl(`/threads/${encodeURIComponent(bot)}/${encodeURIComponent(thread)}`),
      ).pipe(
        // Cookie authentication is in play here; the server requires this
        // header's presence as proof the request came from a same-origin fetch.
        HttpClientRequest.setHeader("X-Mackbot-CSRF", "1"),
        HttpClientRequest.bodyJson({ archived: false } satisfies ThreadUpdate),
      );
      const response = yield* client.execute(request);
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(yield* refusalOf(response));
      }
      yield* HttpClientResponse.schemaBodyJson(ThreadViewSchema)(response);
      return Message.ThreadRestored({ bot, thread });
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed(Message.RestoreFailed({ bot, thread, error: describe(cause) })),
      ),
      Effect.provide(Http.layer),
    ),
});

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
  HttpClientResponse.schemaBodyJson(ErrorBodySchema)(response).pipe(
    Effect.map((body) => body.error),
    Effect.catch(() => Effect.succeed(`the write route answered ${response.status}`)),
  );

/**
 * `POST /chat/:bot` with the text the composer holds. This is the app's one
 * route that starts work instead of observing it. `wait=0` asks for the
 * receipt immediately rather than holding the request open for the run's
 * result; the transcript and its SSE stream are how the answer arrives.
 */
export const Chat = Command.define("Chat", {
  args: { bot: Schema.String, text: Schema.String, thread: Schema.optional(Schema.String) },
  messages: [Message.ChatSent, Message.ChatFailed],
  execute: ({ bot, text, thread }) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const request = yield* HttpClientRequest.post(
        apiUrl(`/chat/${encodeURIComponent(bot)}?wait=0`),
      ).pipe(
        // Cookie authentication is in play here; the server requires this
        // header's presence as proof the request came from a same-origin fetch.
        HttpClientRequest.setHeader("X-Mackbot-CSRF", "1"),
        HttpClientRequest.bodyJson({ text, ...threadField(thread) }),
      );
      const response = yield* client.execute(request);
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(yield* refusalOf(response));
      }
      const accepted = yield* HttpClientResponse.schemaBodyJson(ChatAcceptedSchema)(response);
      return Message.ChatSent({ bot, ...threadField(thread), operationId: accepted.operationId });
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed(Message.ChatFailed({ bot, ...threadField(thread), error: describe(cause) })),
      ),
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
        yield* HttpClientResponse.schemaBodyJson(ErrorBodySchema)(response);
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
