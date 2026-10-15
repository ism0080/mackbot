/**
 * feed — the Bot Durable Object's Server-Sent Events surface.
 *
 * One route, `GET /events/:bot?stream=…&from=…`, served through the harness's
 * own `sseResponse`. Resume (`Last-Event-ID`, `?from=`), the `up-to-date`
 * control frame, heartbeats, `done`/`error`, 404 on a missing stream and
 * abort-on-disconnect are the SDK's implementation, not ours.
 *
 * The stream is named by `?stream=` only until the run-identity rule lands; the
 * bridge that opens a stream per run and appends encoded Frames belongs here
 * and will replace that lookup.
 */

import type { Streams } from "agents/streams";
import { sseResponse } from "agents/streams";

/** How long an idle tail may stay silent before it sends a comment frame. */
const HEARTBEAT_MS = 25_000;

const methodNotAllowed = (): Response =>
  Response.json({ error: "method not allowed" }, { status: 405 });

export const serveEvents = (streams: Streams, request: Request): Promise<Response> => {
  if (request.method !== "GET") return Promise.resolve(methodNotAllowed());
  const streamId = new URL(request.url).searchParams.get("stream");
  if (streamId === null || streamId === "") {
    return Promise.resolve(Response.json({ error: "stream is required" }, { status: 400 }));
  }
  return sseResponse(streams, streamId, { request, heartbeatMs: HEARTBEAT_MS });
};
