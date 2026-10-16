/*
 * The stub Worker: the two documented routes, over real HTTP, so the built app
 * hits a boundary rather than a hand-built object. It records every request it
 * serves so a test can assert the method, path and query the app actually sent.
 */
import { slicePage } from "../../../src/transcript.ts";

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

export const startStub = ({ status, transcripts, failing = [] }) => {
  const requests = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const query = Object.fromEntries(url.searchParams);
      requests.push({ method: request.method, path: url.pathname, query });

      if (failing.includes(url.pathname)) return new Response("boom", { status: 500 });
      if (url.pathname === "/status") return Response.json(status);

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
    stop: () => server.stop(true),
  };
};
