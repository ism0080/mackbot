import { BotViewSchema, TranscriptPageSchema } from "@mackbot/web-contract";
import { Clock, Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Command, Http } from "foldkit";

import { Message } from "./message.ts";

/**
 * The two Commands that are the app's whole data source. Each one decodes its
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
    const { bots, errors } = yield* HttpClientResponse.schemaBodyJson(StatusResponseSchema)(
      response,
    );
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
