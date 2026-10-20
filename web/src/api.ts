import {
  AbortResultSchema,
  BotViewSchema,
  RetryResultSchema,
  TranscriptPageSchema,
} from "@mackbot/contract";
import type { AbortRequest } from "@mackbot/contract";
import type { ApprovalDecision } from "@mackbot/contract";
import { Clock, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { Command, Http } from "foldkit";

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
 * The Worker origin. Same-origin by default because the Worker serves this app;
 * a deployment that splits them sets `VITE_API_BASE`. No token is bundled — the
 * browser surface authenticates with a cookie, because `EventSource` cannot set
 * an `Authorization` header. The bearer never leaves the machine.
 */
export const apiUrl = (path: string): string => {
  const configured = import.meta.env.VITE_API_BASE;
  if (configured === undefined || configured === "") return `${globalThis.location.origin}${path}`;
  return `${configured.replace(/\/+$/u, "")}${path}`;
};

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
        Effect.succeed(Message.TranscriptFailed({ bot, error: describe(cause) })),
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

const DecisionRefusedSchema = Schema.Struct({ error: Schema.String });

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
        yield* HttpClientResponse.schemaBodyJson(DecisionRefusedSchema)(response);
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
