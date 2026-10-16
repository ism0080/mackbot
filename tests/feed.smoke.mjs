/**
 * Smoke test for the harness bridge (src/feed.ts): harness event batches become
 * durable Frames on a real `Streams`, served by the real `sseResponse`.
 *
 * Run with: bun tests/feed.smoke.mjs
 *
 * The claims this file has to break if they stop holding:
 *   1. The load-bearing one: the number of chunks tracks the number of commits,
 *      not the number of tokens. A bridge handed coalesced or skipped batches
 *      fails here, which is what sanctions the reuse argument.
 *   2. Chunk zero is a `snapshot` Frame and the last chunk of a run is a run
 *      end, so a fresh attach always has a base and a terminal signal.
 *   3. The generation boundary: after rotation a second stream exists under the
 *      same tag, a stale `?gen=` is replayed from `from: 0` even with a stale
 *      `Last-Event-ID`, and folding the segments in order drops and repeats no
 *      entry.
 *   4. One watcher per session: a second `attach` neither registers a second
 *      listener nor double-appends.
 *
 * What a stub cannot prove: pi's real producer, its `outputIntervalMs` commit
 * coalescing, and its overflow-to-snapshot path all need a live Durable Object.
 * Here the "model" is a stub `AgentEventStream` the test drives batch by batch,
 * so claim 1 is exercised against the bridge's own serialization, not pi's real
 * scheduler. That is stated plainly in the report.
 *
 * `agents/lifecycle` imports the `cloudflare:workers` builtin, which Bun cannot
 * resolve, so this re-execs with `tests/shims` on NODE_PATH — the same pattern
 * streams.smoke.mjs uses.
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
const { createRunStore, streamIdFor } = await import("../src/runs.ts");
const { createFeed, streamTagFor } = await import("../src/feed.ts");
const { sqliteStorage } = await import("./support/sqlite.mjs");

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
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
  id: { name: "feed-smoke" },
  storage,
  blockConcurrencyWhile: (run) => Promise.resolve().then(run),
  waitUntil: () => {},
};

const streams = new Streams();
// One host whose handler follows whichever feed the current block installs, so
// every feed shares one real Streams capability and one real Lifecycle.
let currentFeed;
const host = { ctx, onRequest: (request) => currentFeed.serve(request) };
const lifecycle = Lifecycle.install(host);
lifecycle.use(streams);

const runs = createRunStore(sqliteStorage(db));

// ---------------------------------------------------------------------------
// The stub model: an event stream the test drives one commit at a time.
// ---------------------------------------------------------------------------

const USAGE = {
  input: 10,
  output: 4,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 14,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const ENTRY_USER = 10;
const ENTRY_ASSISTANT = 42;

const userEntry = {
  id: ENTRY_USER,
  conversationId: 1,
  kind: "pi.user",
  model: [{ role: "user", content: "hello", timestamp: 1 }],
};

const assistantEntry = {
  id: ENTRY_ASSISTANT,
  conversationId: 1,
  kind: "pi.assistant",
  model: [
    {
      role: "assistant",
      content: [{ type: "text", text: "hello back" }],
      api: "openai",
      provider: "opencode-go",
      model: "stub",
      usage: USAGE,
      stopReason: "stop",
      timestamp: 2,
    },
  ],
};

const SNAPSHOT = {
  type: "snapshot",
  entries: [userEntry],
  tools: [],
  nestedTools: [],
  compactions: [],
  inbox: [],
  agent: {},
  usage: { models: {}, tools: {} },
};

// One commit carries many token deltas but is one event, so a bridge that
// counts tokens instead of commits lands on 40 frames, not 6.
const TOKENS_PER_COMMIT = 20;
const delta = Array.from({ length: TOKENS_PER_COMMIT }, () => ({
  type: "text_delta",
  contentIndex: 0,
  delta: "t",
}));

const COMMITS = [
  [{ type: "run_start", inputs: [1] }],
  [{ type: "message_start", message: assistantEntry.model[0] }],
  [{ type: "message_update", usage: USAGE, changes: delta }],
  [{ type: "message_update", usage: USAGE, changes: delta }],
  [{ type: "message_end", entry: assistantEntry }],
  [{ type: "run_end", inputs: [1] }],
];

const makeStubModel = () => {
  let listener;
  let starts = 0;
  return {
    stream: {
      snapshot: SNAPSHOT,
      start: (fn) => {
        starts += 1;
        listener = fn;
      },
      stop: async () => ({}),
      closed: Promise.resolve({}),
    },
    starts: () => starts,
    commit: (events) => listener(events),
  };
};

const makeFeed = (stub, session, maxChunksPerStream) =>
  createFeed({
    botId: "hermes",
    streams,
    runs,
    events: async () => stub.stream,
    sessionOf: async () => session,
    maxChunksPerStream,
  });

// ---------------------------------------------------------------------------
// Helpers over a stream and its SSE response
// ---------------------------------------------------------------------------

const readAll = async (streamId) => {
  const chunks = [];
  for await (const chunk of streams.read(streamId)) chunks.push(chunk);
  return chunks;
};

const idsOf = (text) => [...text.matchAll(/^id: (\d+)$/gmu)].map((match) => Number(match[1]));

const framesOf = (text) =>
  [...text.matchAll(/^id: (\d+)\ndata: (.+)$/gmu)].map((match) => ({
    seq: Number(match[1]),
    frame: JSON.parse(match[2]),
  }));

const readUntilDone = async (response) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.includes("event: up-to-date") || text.includes("event: done")) break;
  }
  await reader.cancel();
  return text;
};

/** Entries reachable from a Frame sequence, merged by id and never repeated. */
const foldEntryIds = (frames) => {
  const seen = new Set();
  const ids = [];
  for (const frame of frames) {
    const entries =
      frame.kind === "snapshot"
        ? frame.entries
        : frame.kind === "message" && frame.entry !== undefined
          ? [frame.entry]
          : [];
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      ids.push(entry.id);
    }
  }
  return ids;
};

const EVENTS = "https://mackbot.test/events/hermes";

// ---------------------------------------------------------------------------
// Claim 1: chunks track commits, not tokens — and the snapshot is chunk zero.
// ---------------------------------------------------------------------------

{
  runs.open({
    sessionId: "1",
    operationId: "http:a",
    inputs: ["hello"],
    startedAt: 1_000,
    startEntry: 1,
  });
  const stub = makeStubModel();
  currentFeed = makeFeed(stub, "1");
  await currentFeed.attach("1");

  const seeded = await streams.status(streamIdFor("1", 1));
  check("attach opens the admitted run's stream", seeded?.streamId === streamIdFor("1", 1), seeded?.streamId);
  check("attach seeds chunk zero", seeded?.cursor === 1, `${seeded?.cursor}`);

  const before = seeded.cursor;
  // Deliver every commit without awaiting the listener, the way a producer that
  // does not await it could; the bridge's own chain must still serialize them.
  await Promise.all(COMMITS.map((commit) => stub.commit(commit)));
  const after = await streams.status(streamIdFor("1", 1));

  check(
    "one chunk per commit",
    after.cursor - before === COMMITS.length,
    `${after.cursor - before} vs ${COMMITS.length}`,
  );
  check(
    "chunks do not track tokens",
    after.cursor - 1 !== 1 + TOKENS_PER_COMMIT * 2,
    `${after.cursor}`,
  );

  const chunks = await readAll(streamIdFor("1", 1));
  check("chunk zero is a snapshot Frame", chunks[0]?.chunk.kind === "snapshot", chunks[0]?.chunk.kind);
  check("the snapshot carries generation 1", chunks[0]?.chunk.generation === 1, `${chunks[0]?.chunk.generation}`);
  const last = chunks.at(-1);
  check(
    "the last chunk is a run end",
    last?.chunk.kind === "run" && last?.chunk.phase === "end",
    `${last?.chunk.kind}/${last?.chunk.phase}`,
  );
  check("the chunk log is the snapshot plus one frame per commit", chunks.length === 1 + COMMITS.length, `${chunks.length}`);

  const served = await readUntilDone(await host.fetch(new Request(EVENTS)));
  check("the route serves the stream as SSE", idsOf(served)[0] === 0, JSON.stringify(idsOf(served)));
  check("the served generation is in band", framesOf(served)[0]?.frame.generation === 1);
}

// ---------------------------------------------------------------------------
// Claim 4: one watcher per session; a second attach cannot double-append.
// ---------------------------------------------------------------------------

{
  runs.open({
    sessionId: "2",
    operationId: "http:b",
    inputs: ["again"],
    startedAt: 1_000,
    startEntry: 1,
  });
  const stub = makeStubModel();
  const feed = makeFeed(stub, "2");
  await feed.attach("2");
  await feed.attach("2");

  check("a second attach registers no second listener", stub.starts() === 1, `${stub.starts()}`);

  await stub.commit([{ type: "run_start", inputs: [1] }]);
  const status = await streams.status(streamIdFor("2", 1));
  check("one watcher appends one frame per event", status?.cursor === 2, `${status?.cursor}`);
}

// ---------------------------------------------------------------------------
// Claim 3: the generation boundary. A low ceiling forces a second segment.
// ---------------------------------------------------------------------------

{
  runs.open({
    sessionId: "3",
    operationId: "http:c",
    inputs: ["gen"],
    startedAt: 1_000,
    startEntry: 1,
  });
  const stub = makeStubModel();
  currentFeed = makeFeed(stub, "3", 4);
  await currentFeed.attach("3");
  await Promise.all(COMMITS.map((commit) => stub.commit(commit)));

  const tag = streamTagFor("hermes", "3");
  const segments = await streams.list({ tag });
  check("rotation opens a second segment", segments.length === 2, `${segments.length}`);
  check("the newest segment is the next generation", segments[0]?.streamId === streamIdFor("3", 2), segments[0]?.streamId);
  const newest = await streams.list({ tag, limit: 1 });
  check("list({tag, limit:1}) finds the newest segment", newest[0]?.streamId === streamIdFor("3", 2), newest[0]?.streamId);
  check("the settled head is completed", segments[1]?.state === "completed", segments[1]?.state);

  const stale = framesOf(
    await readUntilDone(
      await host.fetch(new Request(`${EVENTS}?gen=1`, { headers: { "Last-Event-ID": "99" } })),
    ),
  );
  check("a stale gen replays from zero", stale[0]?.seq === 0, `${stale[0]?.seq}`);
  const newestCursor = (await streams.status(streamIdFor("3", 2))).cursor;
  check(
    "the stale Last-Event-ID did not skip the new segment's head",
    JSON.stringify(stale.map((entry) => entry.seq)) ===
      JSON.stringify(Array.from({ length: newestCursor }, (_, index) => index)),
    JSON.stringify(stale.map((entry) => entry.seq)),
  );
  check("the reseeded snapshot names the new generation", stale[0]?.frame.kind === "snapshot" && stale[0]?.frame.generation === 2, `${stale[0]?.frame.generation}`);

  const fresh = framesOf(await readUntilDone(await host.fetch(new Request(`${EVENTS}?gen=2&from=1`))));
  check("a current gen resumes from ?from=", fresh[0]?.seq === 1, `${fresh[0]?.seq}`);

  const head = (await readAll(streamIdFor("3", 1))).map((chunk) => chunk.chunk);
  const folded = foldEntryIds([...head, ...stale.map((entry) => entry.frame)]);
  check("folding the segments in order repeats no entry", folded.length === new Set(folded).size, JSON.stringify(folded));
  check("folding the segments in order skips no entry", JSON.stringify(folded) === JSON.stringify([ENTRY_USER, ENTRY_ASSISTANT]), JSON.stringify(folded));
}

// ---------------------------------------------------------------------------
// A later run's segment seeds from entries the earlier run appended, so a
// client that resets its window on the generation change keeps the transcript.
// ---------------------------------------------------------------------------

{
  runs.open({
    sessionId: "4",
    operationId: "http:d",
    inputs: ["one"],
    startedAt: 1_000,
    startEntry: 1,
  });
  const stub = makeStubModel();
  const feed = makeFeed(stub, "4");
  await feed.attach("4");
  await Promise.all(COMMITS.map((commit) => stub.commit(commit)));

  runs.open({
    sessionId: "4",
    operationId: "http:e",
    inputs: ["two"],
    startedAt: 2_000,
    startEntry: 3,
  });
  await Promise.all(COMMITS.map((commit) => stub.commit(commit)));

  const second = (await readAll(streamIdFor("4", 2))).map((chunk) => chunk.chunk);
  check("a second run opens the next generation", second[0]?.generation === 2, `${second[0]?.generation}`);
  check("the new segment seeds a snapshot", second[0]?.kind === "snapshot", second[0]?.kind);
  check(
    "the seed carries entries the earlier run appended",
    JSON.stringify(second[0]?.entries.map((entry) => entry.id)) ===
      JSON.stringify([ENTRY_USER, ENTRY_ASSISTANT]),
    JSON.stringify(second[0]?.entries.map((entry) => entry.id)),
  );
}

if (failures.length > 0) {
  console.error("feed smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("feed smoke passed");
process.exit(0);
