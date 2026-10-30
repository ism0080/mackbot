/**
 * http - the response vocabulary every Worker route shares.
 *
 * The refusals each route answers with, the security headers every response
 * the Worker itself generates carries, and the bounded JSON body reader the
 * mutation routes decode with. Nothing here knows a route; the router and the
 * handlers compose it.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** The largest body any route reads. A chat message is the biggest by far. */
export const MAX_BODY_BYTES = 256 * 1024;

export const jsonError = (status: number, error: string): Response =>
  Response.json({ error }, { status });

export const methodNotAllowed = (): Response => jsonError(405, "method not allowed");

export const invalidBody = (): Response => jsonError(400, "invalid request body");

export const unknownBot = (botId: string): Response => jsonError(404, `unknown bot "${botId}"`);

/**
 * The policy for a response that is data, never a document: nothing it names
 * may load, and no page may frame it.
 */
export const API_CONTENT_SECURITY_POLICY =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * Add the security headers to a response the Worker generated.
 *
 * The built app is served by the assets binding and is not passed through
 * here, so its own policy (and Vite's dev server) are left alone. The response
 * is copied first, because a redirect or a response fetched from a Durable
 * Object has immutable headers.
 */
export const secured = (
  response: Response,
  contentSecurityPolicy: string = API_CONTENT_SECURITY_POLICY,
): Response => {
  const copy = new Response(response.body, response);
  // A route that set its own policy (the login page) keeps it.
  if (!copy.headers.has("Content-Security-Policy")) {
    copy.headers.set("Content-Security-Policy", contentSecurityPolicy);
  }
  copy.headers.set("X-Frame-Options", "DENY");
  copy.headers.set("X-Content-Type-Options", "nosniff");
  copy.headers.set("Referrer-Policy", "no-referrer");
  return copy;
};

export class BodyTooLarge extends Schema.TaggedError<BodyTooLarge>()("BodyTooLarge", {
  maxBytes: Schema.Number,
}) {}

const readCapped = async (
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string | undefined> => {
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  // Leaving the loop early cancels the stream, so an oversized body is not
  // drained.
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) return undefined;
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
};

/**
 * Read at most `maxBytes` of the request body. The cap is enforced against the
 * stream, not only `content-length`, so a chunked request cannot bypass it.
 */
export const readBoundedBody = (
  request: Request,
  maxBytes: number = MAX_BODY_BYTES,
): Effect.Effect<string, BodyTooLarge | Schema.SchemaError | Error> => {
  const tooLarge = new BodyTooLarge({ maxBytes });
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return Effect.fail(tooLarge);
  const body = request.body;
  if (body === null) return Effect.succeed("");
  return Effect.tryPromise({
    try: () => readCapped(body, maxBytes),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(
    Effect.flatMap((text) => (text === undefined ? Effect.fail(tooLarge) : Effect.succeed(text))),
  );
};

/**
 * A JSON body decoded with `schema`, or `undefined` when it is too large,
 * unreadable or does not decode. `emptyBody` stands in for a body that is
 * empty, for the routes where every field is optional.
 */
export const readJsonBody = <A>(
  request: Request,
  schema: Schema.Codec<A, unknown>,
  emptyBody?: string,
): Promise<A | undefined> =>
  Effect.runPromise(
    readBoundedBody(request).pipe(
      Effect.map((raw) => (emptyBody !== undefined && raw.trim().length === 0 ? emptyBody : raw)),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
      Effect.orElseSucceed(() => undefined),
    ),
  );
