/**
 * Smoke test for the DO's SSE surface (src/feed.ts) over the real `Streams`
 * capability and the real `sseResponse`.
 *
 * Run with: bun tests/streams.smoke.mjs
 *
 * This is the unit that proves reuse rather than a hand-rolled SSE writer: it
 * installs `Streams` on a minimal Durable Object with a real `Lifecycle`, opens
 * a stream, appends hand-made Frames through the capability's public writer, and
 * reads the response the lifecycle serves — including resume-by-cursor, which is
 * exactly the machinery the browser client will depend on.
 *
 * `agents/lifecycle` imports the `cloudflare:workers` builtin for its side
 * effects, which Bun cannot resolve. Re-exec with `tests/shims` on NODE_PATH so
 * that import resolves to an empty module; the rest of the capability is real.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
if (process.env.MACKBOT_WORKERS_SHIM !== "1") {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_PATH: join(here, "shims"),
      MACKBOT_WORKERS_SHIM: "1",
    },
  });
  process.exit(result.status ?? 1);
}

const { Database } = await import("bun:sqlite");
const { Lifecycle } = await import("agents/lifecycle");
const { Streams } = await import("agents/streams");
const { serveEvents } = await import("../src/feed.ts");

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
};

// ---------------------------------------------------------------------------
// A minimal Durable Object: one SQLite cursor over bun:sqlite, KV on a Map.
// ---------------------------------------------------------------------------

const db = new Database(":memory:");

const cursorOf = (rows, rowsWritten, columnNames) => ({
  columnNames,
  rowsWritten,
  toArray: () => rows.slice(),
  one: () => rows[0],
  raw: () => rows.map((row) => Object.values(row)),
  [Symbol.iterator]: () => rows.slice()[Symbol.iterator](),
});

const sql = {
  exec(query, ...params) {
    const statement = db.query(query);
    if (statement.columnNames.length > 0) {
      return cursorOf(statement.all(...params), 0, statement.columnNames);
    }
    const info = statement.run(...params);
    return cursorOf([], info.changes ?? 0, []);
  },
};

const kv = new Map();
const storage = {
  sql,
  get: (key) => Promise.resolve(kv.get(key)),
  put: (key, value) => {
    kv.set(key, value);
    return Promise.resolve();
  },
  delete: (key) => {
    kv.delete(key);
    return Promise.resolve(true);
  },
  setAlarm: () => Promise.resolve(),
  getAlarm: () => Promise.resolve(null),
  deleteAlarm: () => Promise.resolve(),
  transactionSync: (run) => {
    db.exec("BEGIN");
    try {
      const value = run();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
};

const ctx = {
  id: { name: "streams-smoke" },
  storage,
  blockConcurrencyWhile: (run) => Promise.resolve().then(run),
  waitUntil: () => {},
};

const streams = new Streams();
const host = { ctx, onRequest: (request) => serveEvents(streams, request) };
const lifecycle = Lifecycle.install(host);
lifecycle.use(streams);

// ---------------------------------------------------------------------------
// Helpers over the SSE response
// ---------------------------------------------------------------------------

const idsOf = (text) => [...text.matchAll(/^id: (\d+)$/gmu)].map((match) => Number(match[1]));

const readUntilUpToDate = async (response) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.includes("event: up-to-date")) break;
  }
  await reader.cancel();
  return text;
};

const get = (url, headers = {}) => host.fetch(new Request(url, { headers }));

const EVENTS = "https://mackbot.test/events/hermes";

// ---------------------------------------------------------------------------
// One stream, three appended Frames
// ---------------------------------------------------------------------------

const STREAM = "feed:1:1";
const writer = await streams.open(STREAM, { tag: "feed:hermes:1" });
writer.append({ kind: "run", phase: "start" });
writer.append({ kind: "usage" });
writer.append({ kind: "run", phase: "end" });

const first = await get(`${EVENTS}?stream=${STREAM}`);
check("response is SSE", first.headers.get("content-type")?.startsWith("text/event-stream") === true);
check("stream exists", first.status === 200, `${first.status}`);

const firstText = await readUntilUpToDate(first);
check("three frames arrive in order", JSON.stringify(idsOf(firstText)) === "[0,1,2]", firstText.trim());
check("the durable tail signals up-to-date", firstText.includes("event: up-to-date"));
check("no control frame precedes the chunks", firstText.indexOf("event: up-to-date") > firstText.indexOf("id: 2"));

// A fourth Frame makes the resume assertions distinguish "skip 0" from "skip 0 and 1".
writer.append({ kind: "done" });

const resumed = await get(`${EVENTS}?stream=${STREAM}`, { "Last-Event-ID": "1" });
const resumedText = await readUntilUpToDate(resumed);
check("Last-Event-ID resumes after the cursor", JSON.stringify(idsOf(resumedText)) === "[2,3]", resumedText.trim());
check("Last-Event-ID does not replay chunk 0", !resumedText.includes("id: 0"));

const fromParam = await get(`${EVENTS}?stream=${STREAM}&from=2`);
const fromText = await readUntilUpToDate(fromParam);
check("?from= resumes from the cursor", JSON.stringify(idsOf(fromText)) === "[2,3]", fromText.trim());
check("?from= does not replay chunk 0", !fromText.includes("id: 0"));

const missing = await get(`${EVENTS}?stream=feed:does-not-exist`);
check("an unknown stream is 404", missing.status === 404, `${missing.status}`);

const wrongMethod = await host.fetch(new Request(`${EVENTS}?stream=${STREAM}`, { method: "POST" }));
check("a non-GET is 405", wrongMethod.status === 405, `${wrongMethod.status}`);

if (failures.length > 0) {
  console.error("streams smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("streams smoke passed");
process.exit(0);
