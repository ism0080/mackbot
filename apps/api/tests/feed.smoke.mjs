/**
 * Smoke test for the harness bridge (src/feed.ts): pi's committed conversation
 * view becomes durable Frames on a real `Streams`, served by the real
 * `sseResponse`.
 *
 * Run with: bun tests/feed.smoke.mjs
 *
 * The claims this file has to break if they stop holding:
 *   1. The load-bearing one: one watch value becomes a bounded set of frames —
 *      a snapshot at a segment's sequence zero, then only the entries whose ids
 *      the segment has not delivered and only the documents that changed. A
 *      bridge that re-sends the whole transcript on every commit fails here.
 *   2. Run identity comes from the submissions: a `run: start` when the newest
 *      submission is admitted and a `run: end` when it settles, both naming the
 *      submission's request id and never a guessed window.
 *   3. The generation boundary: at the chunk ceiling a second segment exists
 *      under the same tag, its sequence zero is a snapshot of the whole current
 *      view, a stale `?gen=` is replayed from `from: 0` even with a stale
 *      `Last-Event-ID`, and a current `?gen=` resumes from `?from=`.
 *   4. Retention: settled segments past the newest few are deleted.
 *   5. One watcher per session: a second `attach` neither registers a second
 *      listener nor double-appends.
 *
 * What a stub cannot prove: pi's real producer, its commit coalescing, and its
 * own view hydration need a live Durable Object. Here the "conversation" is a
 * stub watch the test drives value by value, so claim 1 is exercised against
 * the bridge's own diffing, not pi's scheduler.
 *
 * `agents/lifecycle` imports the `cloudflare:workers` builtin, which Bun cannot
 * resolve, so this re-execs under the shim in `tests/support/workers-shim.mjs`.
 */
import { withWorkersShim } from "./support/workers-shim.mjs";

withWorkersShim(import.meta.url);

const { Database } = await import("bun:sqlite");
const { Lifecycle } = await import("agents/lifecycle");
const { Streams } = await import("agents/streams");
const { Schema } = await import("effect");
const { FrameSchema, streamIdFor } = await import("@mackbot/contract");
const { createFeed, RETENTION_STREAMS, streamTagFor } = await import("../src/feed.ts");

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

// ---------------------------------------------------------------------------
// The stub model: pi's conversation view, driven one commit at a time.
// ---------------------------------------------------------------------------

const ENTRY_USER = 10;
const ENTRY_ANSWER = 42;

const userEntry = {
  id: ENTRY_USER,
  conversationId: 1,
  kind: "pi.user",
  model: [{ role: "user", content: "hello", timestamp: 1 }],
};

const assistantEntry = {
  id: ENTRY_ANSWER,
  conversationId: 1,
  kind: "pi.assistant",
  model: [
    {
      role: "assistant",
      content: [{ type: "text", text: "hello back" }],
      api: "openai",
      provider: "opencode-go",
      model: "stub",
      usage: {
        input: 10,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 14,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    },
  ],
};

/** One committed view: the whole active transcript and the built-in documents. */
const viewOf = (entries, docs = {}) => ({
  conversation: { id: 1 },
  entries,
  docs,
});

const LIVE_RUNNING = { run: { inputs: [1] } };
const LIVE_STREAMING = {
  run: { inputs: [1] },
  generation: {
    attempt: 1,
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "hello back" },
        { type: "thinking", thinking: "hmm" },
      ],
    },
  },
  tools: [{ callId: "call-1", name: "executor", status: "running", output: "partial" }],
};
const INBOX = { items: [{ id: 2, mode: "followUp", content: "more" }] };
const USAGE = { models: { "opencode-go/stub": { input: 10, output: 4 } } };

const placed = (id, requestId, entry) => ({
  id,
  conversationId: 1,
  type: "input",
  status: "placed",
  requestId,
  entry,
});
const done = (id, requestId, entry, answer) => ({
  id,
  conversationId: 1,
  type: "input",
  status: "done",
  requestId,
  entry,
  answer,
});

/**
 * A fake `Conversation.watch()`: `value` is what a fresh watch acquires, and
 * `commit` delivers the next committed view to the one registered listener.
 */
const makeSession = (initial) => {
  let listener;
  let starts = 0;
  const session = {
    submissions: [],
    watch: {
      value: initial,
      start: (fn) => {
        starts += 1;
        listener = fn;
      },
    },
    starts: () => starts,
    commit: async (next) => {
      session.watch.value = next;
      await listener(next);
    },
  };
  return session;
};

const makeFeed = (session, resolve, maxChunksPerStream) =>
  createFeed({
    botId: "hermes",
    streams,
    watch: async () => session.watch,
    submissions: async () => session.submissions,
    sessionOf: async () => resolve,
    maxChunksPerStream,
  });

// ---------------------------------------------------------------------------
// Helpers over a stream and its SSE response
// ---------------------------------------------------------------------------

const framesOf = (text) =>
  [...text.matchAll(/^id: (\d+)\ndata: (.+)$/gmu)].map((match) => ({
    seq: Number(match[1]),
    frame: JSON.parse(match[2]),
  }));

const kindsOf = (frames) =>
  frames.map((entry) =>
    entry.frame.kind === "run" ? `run:${entry.frame.phase}` : entry.frame.kind,
  );

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

/** The first chunk of a stream, whether it is settled or still streaming. */
const firstChunkOf = async (streamId) => {
  for await (const chunk of streams.read(streamId)) return chunk;
  return undefined;
};

const EVENTS = "https://mackbot.test/events/hermes";

const get = (url, headers = {}) => host.fetch(new Request(url, { headers }));

// ---------------------------------------------------------------------------
// Claim 1 and 2: the snapshot, the entry diff, the documents and the run.
// ---------------------------------------------------------------------------

{
  const session = makeSession(viewOf([userEntry]));
  currentFeed = makeFeed(session, "1");
  await currentFeed.attach("1");
  await currentFeed.attach("1");
  check(
    "a second attach registers no second listener",
    session.starts() === 1,
    `${session.starts()}`,
  );

  const seedStatus = await streams.status(streamIdFor("1", 1));
  check(
    "attach opens generation 1",
    seedStatus?.streamId === streamIdFor("1", 1),
    seedStatus?.streamId,
  );
  check("attach seeds one chunk", seedStatus?.cursor === 1, `${seedStatus?.cursor}`);

  const seeded = framesOf(await readUntilDone(await get(EVENTS)));
  check(
    "sequence zero is a snapshot",
    seeded[0]?.frame.kind === "snapshot" && seeded[0]?.seq === 0,
    `${seeded[0]?.seq}/${seeded[0]?.frame.kind}`,
  );
  check(
    "the snapshot carries the whole window oldest first",
    JSON.stringify(seeded[0]?.frame.entries.map((entry) => entry.id)) ===
      JSON.stringify([ENTRY_USER]),
    JSON.stringify(seeded[0]?.frame.entries.map((entry) => entry.id)),
  );
  check(
    "the seeded entries are dated by delivery",
    Number.isSafeInteger(seeded[0]?.frame.entries[0]?.at),
    `${seeded[0]?.frame.entries[0]?.at}`,
  );
  check(
    "an idle session reports no run",
    seeded[0]?.frame.live.run === undefined,
    JSON.stringify(seeded[0]?.frame.live.run),
  );
  check("an idle inbox is empty", seeded[0]?.frame.inbox.length === 0);
  check(
    "an empty ledger sums to zero",
    seeded[0]?.frame.usage.inputTokens === 0 && seeded[0]?.frame.usage.exchanges === 0,
  );

  // The run is admitted: pi's `pi.live` names the input, the submissions name
  // the operation.
  session.submissions = [placed(1, "http:a", ENTRY_USER)];
  await session.commit(viewOf([userEntry], { "pi.live": LIVE_RUNNING }));

  // The answer lands, with the streaming partial, the queued follow-up and the
  // ledger moving in the same commit.
  await session.commit(
    viewOf([userEntry, assistantEntry], {
      "pi.live": LIVE_STREAMING,
      "pi.inbox": INBOX,
      "pi.usage": USAGE,
    }),
  );

  // The run settles: the submission is answered, `pi.live` is cleared. The
  // inbox and the ledger are documents, so they stay as pi committed them.
  session.submissions = [done(1, "http:a", ENTRY_USER, ENTRY_ANSWER)];
  await session.commit(
    viewOf([userEntry, assistantEntry], { "pi.inbox": INBOX, "pi.usage": USAGE }),
  );

  const frames = framesOf(await readUntilDone(await get(EVENTS)));
  check(
    "one frame per changed surface, in fold order",
    JSON.stringify(kindsOf(frames)) ===
      JSON.stringify([
        "snapshot",
        "run:start",
        "live",
        "append",
        "live",
        "inbox",
        "usage",
        "run:end",
        "live",
      ]),
    JSON.stringify(kindsOf(frames)),
  );
  check(
    "every frame is a contract Frame",
    frames.every((entry) => Schema.is(FrameSchema)(entry.frame)),
    JSON.stringify(frames.filter((entry) => !Schema.is(FrameSchema)(entry.frame))),
  );

  const started = frames.find(
    (entry) => entry.frame.kind === "run" && entry.frame.phase === "start",
  );
  check(
    "a run start names the submission's operation",
    started?.frame.operationId === "http:a",
    started?.frame.operationId,
  );
  const ended = frames.find((entry) => entry.frame.kind === "run" && entry.frame.phase === "end");
  check(
    "a run end names the settled submission's operation",
    ended?.frame.operationId === "http:a",
    ended?.frame.operationId,
  );

  const appended = frames.find((entry) => entry.frame.kind === "append");
  check(
    "only the unseen entry is appended",
    JSON.stringify(appended?.frame.entries.map((entry) => entry.id)) ===
      JSON.stringify([ENTRY_ANSWER]),
    JSON.stringify(appended?.frame.entries.map((entry) => entry.id)),
  );
  check(
    "the appended entry records the run's origin",
    appended?.frame.entries[0]?.origin === "http",
    appended?.frame.entries[0]?.origin,
  );

  const partial = frames.filter((entry) => entry.frame.kind === "live").at(-2);
  check(
    "a live frame carries the partial text",
    partial?.frame.live.generation?.text === "hello back",
    partial?.frame.live.generation?.text,
  );
  check(
    "a live frame carries the partial thinking",
    partial?.frame.live.generation?.thinking === "hmm",
    partial?.frame.live.generation?.thinking,
  );
  check(
    "a live frame carries the tool round",
    partial?.frame.live.tools[0]?.status === "running" &&
      partial?.frame.live.tools[0]?.output === "partial",
    JSON.stringify(partial?.frame.live.tools),
  );
  check(
    "the live run resolves the operation from its input submission",
    partial?.frame.live.run?.operationId === "http:a",
    partial?.frame.live.run?.operationId,
  );

  const inbox = frames.find((entry) => entry.frame.kind === "inbox");
  check(
    "the inbox frame carries the queued follow-up",
    inbox?.frame.items[0]?.mode === "followUp" && inbox?.frame.items[0]?.text === "more",
    JSON.stringify(inbox?.frame.items),
  );
  check("the inbox item names its submission", inbox?.frame.items[0]?.id === "2");

  const usage = frames.find((entry) => entry.frame.kind === "usage");
  check(
    "the usage frame sums the ledger",
    usage?.frame.usage.inputTokens === 10 &&
      usage?.frame.usage.outputTokens === 4 &&
      usage?.frame.usage.exchanges === 1,
    JSON.stringify(usage?.frame.usage),
  );
  check(
    "the settled run leaves no live run",
    frames.at(-1)?.frame.live.run === undefined,
    JSON.stringify(frames.at(-1)?.frame.live.run),
  );
}

// ---------------------------------------------------------------------------
// Claim 3: the generation boundary, the reseeded snapshot and resume.
// ---------------------------------------------------------------------------

{
  const session = makeSession(viewOf([userEntry, assistantEntry]));
  currentFeed = makeFeed(session, "2", 3);
  await currentFeed.attach("2");
  for (let minted = 1; minted <= 5; minted += 1) {
    await session.commit(
      viewOf([userEntry, assistantEntry], {
        "pi.usage": { models: { "opencode-go/stub": { input: minted, output: minted } } },
      }),
    );
  }

  const tag = streamTagFor("hermes", "2");
  const segments = await streams.list({ tag });
  check("rotation opens three segments", segments.length === 3, `${segments.length}`);
  check(
    "the newest segment is the latest generation",
    segments[0]?.streamId === streamIdFor("2", 3),
    segments[0]?.streamId,
  );
  check("a rotated segment is settled", segments[2]?.state === "completed", segments[2]?.state);
  check(
    "list({tag, limit:1}) finds the newest segment",
    (await streams.list({ tag, limit: 1 }))[0]?.streamId === streamIdFor("2", 3),
  );

  for (const generation of [1, 2]) {
    const chunks = [];
    for await (const chunk of streams.read(streamIdFor("2", generation))) chunks.push(chunk);
    check(
      `segment ${generation} starts with its own snapshot`,
      chunks[0]?.chunk.kind === "snapshot" && chunks[0]?.chunk.generation === generation,
      `${chunks[0]?.chunk.kind}/${chunks[0]?.chunk.generation}`,
    );
    check(
      `segment ${generation} seeds the whole current view`,
      JSON.stringify(chunks[0]?.chunk.entries.map((entry) => entry.id)) ===
        JSON.stringify([ENTRY_USER, ENTRY_ANSWER]),
      JSON.stringify(chunks[0]?.chunk.entries.map((entry) => entry.id)),
    );
  }

  const newestHead = await firstChunkOf(streamIdFor("2", 3));
  check(
    "the live segment also starts with its own snapshot",
    newestHead?.chunk.kind === "snapshot" && newestHead?.chunk.generation === 3,
    `${newestHead?.chunk.kind}/${newestHead?.chunk.generation}`,
  );
  check(
    "the live segment seeds the whole current view",
    JSON.stringify(newestHead?.chunk.entries.map((entry) => entry.id)) ===
      JSON.stringify([ENTRY_USER, ENTRY_ANSWER]),
    JSON.stringify(newestHead?.chunk.entries.map((entry) => entry.id)),
  );

  const stale = framesOf(
    await readUntilDone(await get(`${EVENTS}?gen=1`, { "Last-Event-ID": "99" })),
  );
  check("a stale gen replays from zero", stale[0]?.seq === 0, `${stale[0]?.seq}`);
  check(
    "the stale Last-Event-ID did not skip the new segment's head",
    stale[0]?.frame.kind === "snapshot" && stale[0]?.frame.generation === 3,
    `${stale[0]?.frame.kind}/${stale[0]?.frame.generation}`,
  );
  const newestCursor = (await streams.status(streamIdFor("2", 3))).cursor;
  check(
    "the replay covers every chunk of the newest segment",
    JSON.stringify(stale.map((entry) => entry.seq)) ===
      JSON.stringify(Array.from({ length: newestCursor }, (_, index) => index)),
    JSON.stringify(stale.map((entry) => entry.seq)),
  );

  const resumed = framesOf(await readUntilDone(await get(`${EVENTS}?gen=3&from=1`)));
  check("a current gen resumes from ?from=", resumed[0]?.seq === 1, `${resumed[0]?.seq}`);
  check(
    "a resume does not replay the snapshot",
    resumed.every((entry) => entry.frame.kind !== "snapshot"),
    JSON.stringify(kindsOf(resumed)),
  );

  const byHeader = framesOf(await readUntilDone(await get(EVENTS, { "Last-Event-ID": "0" })));
  check("Last-Event-ID resumes after the cursor", byHeader[0]?.seq === 1, `${byHeader[0]?.seq}`);
}

// ---------------------------------------------------------------------------
// Claim 4: retention sweeps settled segments past the newest few.
// ---------------------------------------------------------------------------

{
  const session = makeSession(viewOf([userEntry]));
  const feed = makeFeed(session, "3", 1);
  await feed.attach("3");
  for (let minted = 1; minted <= 6; minted += 1) {
    await session.commit(
      viewOf([userEntry], {
        "pi.usage": { models: { "opencode-go/stub": { input: minted, output: 0 } } },
      }),
    );
  }

  const tag = streamTagFor("hermes", "3");
  const kept = await streams.list({ tag });
  check(
    "retention keeps the newest few segments",
    kept.length === RETENTION_STREAMS,
    `${kept.length}`,
  );
  check(
    "the newest segment survives retention",
    kept[0]?.streamId === streamIdFor("3", 7),
    kept[0]?.streamId,
  );
  check(
    "the oldest settled segment is swept",
    (await streams.status(streamIdFor("3", 1))) === null,
  );
}

if (failures.length > 0) {
  console.error("feed smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("feed smoke passed");
process.exit(0);
