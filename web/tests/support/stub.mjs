/*
 * The stub Worker: the documented routes, over real HTTP, so the built app hits
 * a boundary rather than a hand-built object. It records every request it
 * serves so a test can assert the method, path and query the app actually sent.
 *
 * `/events/:bot` serves a real `text/event-stream`. A test names the frames a
 * bot's connection should carry, and whether the connection stays open after
 * them; the default is an `up-to-date` control frame on a connection that holds,
 * which is what a running, quiet bot looks like.
 *
 * The roster routes answer the registry's own shapes. A write is echoed back as
 * the bot it stored, unless a test scripts a refusal for that bot.
 */
import { slicePage } from "@mackbot/contract";

/**
 * A faithful implementation of `GET /transcript/:bot`: the same backwards walk
 * by entry id the Durable Object performs, so a client that pages gets exactly
 * the server's pages. `page` is a full `TranscriptPage` whose `entries` are the
 * session's whole history.
 */
export const pager = (page) => (query) => {
  const sliced = slicePage(page.entries, {
    before: query.before === undefined ? undefined : Number(query.before),
    limit: query.limit === undefined ? undefined : Number(query.limit),
  });
  return { ...page, entries: sliced.entries, nextBefore: sliced.nextBefore };
};

/** The SSE wire format `sseResponse` writes: an optional id, an optional event
 *  name, then a JSON data line. */
const sseFrame = ({ id, event, data }) => {
  const lines = [];
  if (id !== undefined) lines.push(`id: ${id}`);
  if (event !== undefined) lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data ?? {})}`);
  return `${lines.join("\n")}\n\n`;
};

export const startStub = ({
  status,
  transcripts,
  failing = [],
  events = {},
  decisions = {},
  aborts = {},
  retries = {},
  roster = { bots: {} },
  catalog = { models: {} },
  writes = {},
  create = undefined,
}) => {
  const requests = [];
  const held = new Set();
  const encoder = new TextEncoder();

  const respondSse = ({ frames = [], hold = false }) => {
    const body = new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(sseFrame(frame)));
        if (hold) held.add(controller);
        else controller.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };

  const quiet = { frames: [{ event: "up-to-date", data: {} }], hold: true };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const query = Object.fromEntries(url.searchParams);
      const connections = requests.filter((entry) => entry.path === url.pathname).length;
      const decision = /^\/approvals\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      const abort = /^\/abort\/([^/]+)$/.exec(url.pathname);
      const retry = /^\/retry\/([^/]+)$/.exec(url.pathname);
      const botWrite = /^\/bots\/([^/]+)$/.exec(url.pathname);
      const isWrite = request.method === "PUT" && botWrite !== null;
      const isCreate = request.method === "POST" && url.pathname === "/bots";
      const hasBody = decision !== null || abort !== null || retry !== null || isWrite || isCreate;
      const body = hasBody ? await request.json().catch(() => undefined) : undefined;
      requests.push({
        method: request.method,
        path: url.pathname,
        query,
        connections,
        body,
        headers: Object.fromEntries(request.headers),
      });

      if (failing.includes(url.pathname)) return new Response("boom", { status: 500 });
      if (url.pathname === "/status") {
        return Response.json(typeof status === "function" ? status() : status);
      }

      if (url.pathname === "/models") {
        return Response.json(typeof catalog === "function" ? catalog() : catalog);
      }

      if (url.pathname === "/bots" && request.method === "GET") {
        return Response.json(typeof roster === "function" ? roster() : roster);
      }

      if (isCreate) {
        const handler = create;
        const spec = handler === undefined ? undefined : await handler({ body, query });
        const answer = spec ?? { status: 201, body: { id: body.id, bot: body.bot } };
        return Response.json(answer.body, { status: answer.status });
      }

      if (isWrite) {
        const handler = writes[botWrite[1]];
        const spec =
          handler === undefined ? undefined : await handler({ body, query, bot: botWrite[1] });
        const answer = spec ?? { status: 200, body: { id: botWrite[1], bot: body.bot } };
        return Response.json(answer.body, { status: answer.status });
      }

      if (decision !== null) {
        const handler = decisions[url.pathname];
        const spec =
          handler === undefined
            ? undefined
            : await handler({ body, query, bot: decision[1], approvalId: decision[2] });
        const answer = spec ?? { status: 404, body: { error: "no decision handler" } };
        return Response.json(answer.body, { status: answer.status });
      }

      if (abort !== null) {
        const handler = aborts[url.pathname];
        const spec =
          handler === undefined ? undefined : await handler({ body, query, bot: abort[1] });
        const answer = spec ?? { status: 404, body: { error: "no abort handler" } };
        return Response.json(answer.body, { status: answer.status });
      }

      if (retry !== null) {
        const handler = retries[url.pathname];
        const spec =
          handler === undefined ? undefined : await handler({ body, query, bot: retry[1] });
        const answer = spec ?? { status: 404, body: { error: "no retry handler" } };
        return Response.json(answer.body, { status: answer.status });
      }

      const eventRoute = /^\/events\/([^/]+)$/.exec(url.pathname);
      if (eventRoute !== null) {
        const handler = events[eventRoute[1]];
        const spec = handler === undefined ? undefined : handler({ query, index: connections });
        return respondSse(spec ?? quiet);
      }

      const transcript = /^\/transcript\/([^/]+)$/.exec(url.pathname);
      if (transcript !== null) {
        const page = transcripts[transcript[1]];
        return page === undefined
          ? Response.json({ error: "unknown bot" }, { status: 404 })
          : Response.json(page(query));
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });

  return {
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => {
      for (const controller of held) {
        try {
          controller.close();
        } catch {
          // Already closed; the stub is stopping anyway.
        }
      }
      held.clear();
      server.stop(true);
    },
  };
};
