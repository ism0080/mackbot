import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, test } from "vitest";

import { THREAD_TITLE_MAX } from "@mackbot/contract";

import {
  legacyThreadSessions,
  listThreads,
  migrateThreadSessions,
  recordActivity,
  recordThread,
  recordThreadUpdate,
  threadTitleOf,
  ThreadsDoc,
} from "../src/threads.ts";
import type { ConversationLiveness, ThreadSessions } from "../src/threads.ts";
import { memoryStorage } from "./support/sqlite.ts";

const idle: ConversationLiveness = { busy: new Set(), approvals: new Map() };

describe("threadTitleOf", () => {
  test("a short first message is its own title", () => {
    expect(threadTitleOf("Draft the Q3 plan")).toBe("Draft the Q3 plan");
  });

  test("the first line that says something names the thread, its spacing collapsed", () => {
    expect(threadTitleOf("\n   \n  Plan   the\tweek \nthen the details")).toBe("Plan the week");
  });

  test("a long message is cut at a word and says it was cut", () => {
    const words = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
    const title = threadTitleOf(words);
    expect(title.length).toBeLessThanOrEqual(THREAD_TITLE_MAX);
    expect(title.endsWith("…")).toBe(true);
    // The cut lands between words, never inside one.
    expect(words.startsWith(title.slice(0, -1))).toBe(true);
    expect(words[title.length - 1]).toBe(" ");
  });
});

describe("migrateThreadSessions", () => {
  test("a version 1 thread map keeps every thread and gains empty records", () => {
    expect(migrateThreadSessions({ threads: { plan: "3", notes: "5" } }, 1)).toEqual({
      threads: { plan: "3", notes: "5" },
      sessions: {},
    });
  });

  test("a value that is neither version starts empty rather than failing every read", () => {
    expect(migrateThreadSessions({ threads: ["3"] }, 1)).toEqual({ threads: {}, sessions: {} });
  });
});

describe("the thread document in a real pi session", () => {
  let harness: Harness | undefined;

  const open = async (): Promise<Harness> => {
    harness = await Harness.open(
      new MemoryStorage(),
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    return harness;
  };

  afterEach(async () => {
    await harness?.close(BACKGROUND_CONTEXT);
    harness = undefined;
  });

  test("the conversation a thread creates is recorded, titled and dated in its own commit", async () => {
    const pi = await open();
    const conversation = await pi.createConversation(
      {
        ownership: { kind: "ownerless" },
        init: (tx, id) => recordThread(tx, "plan", String(id), "Plan the week\nin detail", 1_000),
      },
      BACKGROUND_CONTEXT,
    );
    const session = String(conversation.id);

    expect(await pi.snapshot(ThreadsDoc, BACKGROUND_CONTEXT)).toEqual({
      threads: { plan: session },
      sessions: {
        [session]: {
          title: "Plan the week",
          createdAt: 1_000,
          lastActivityAt: 1_000,
          archived: false,
        },
      },
    });
  });

  test("activity and an archive land on the conversation's record, the root's included", async () => {
    const pi = await open();
    const root = await pi.root(BACKGROUND_CONTEXT);
    const rootSession = String(root.id);
    const thread = await pi.createConversation(
      {
        ownership: { kind: "ownerless" },
        init: (tx, id) => recordThread(tx, "plan", String(id), "Plan", 1_000),
      },
      BACKGROUND_CONTEXT,
    );
    const session = String(thread.id);

    await root.commit((tx) => recordActivity(tx, rootSession, 2_000), BACKGROUND_CONTEXT);
    await thread.commit((tx) => recordActivity(tx, session, 3_000), BACKGROUND_CONTEXT);
    await thread.commit(
      (tx) => recordThreadUpdate(tx, session, { archived: true, title: "Weekly plan" }),
      BACKGROUND_CONTEXT,
    );

    const doc = await pi.snapshot(ThreadsDoc, BACKGROUND_CONTEXT);
    expect(doc?.sessions[rootSession]).toEqual({
      title: null,
      createdAt: null,
      lastActivityAt: 2_000,
      archived: false,
    });
    expect(doc?.sessions[session]).toEqual({
      title: "Weekly plan",
      createdAt: 1_000,
      lastActivityAt: 3_000,
      archived: true,
    });
  });

  test("a map an older isolate stored at version 1 reads back through the migration", async () => {
    const pi = await open();
    const ThreadsDocV1 = defineDoc<{ threads: Record<string, string> }>({
      kind: ThreadsDoc.definition.kind,
      version: 1,
      scope: "session",
      initial: () => ({ threads: {} }),
      checkpointWhen: () => false,
    });
    const root = await pi.root(BACKGROUND_CONTEXT);
    await root.commit(async (tx) => {
      (await tx.doc(ThreadsDocV1)).threads.legacy = "7";
    }, BACKGROUND_CONTEXT);

    expect(await pi.snapshot(ThreadsDoc, BACKGROUND_CONTEXT)).toEqual({
      threads: { legacy: "7" },
      sessions: {},
    });
  });
});

describe("legacyThreadSessions", () => {
  test("every row of the old table is a thread, and a broken row is skipped", () => {
    const storage = memoryStorage();
    storage.db.exec("CREATE TABLE mackbot_threads (thread TEXT PRIMARY KEY, session_id TEXT)");
    storage.db.exec(
      "INSERT INTO mackbot_threads VALUES ('plan', '3'), ('notes', '5'), ('broken', NULL)",
    );

    expect(legacyThreadSessions(storage)).toEqual({ plan: "3", notes: "5" });
  });
});

describe("listThreads", () => {
  const doc: ThreadSessions = {
    threads: { older: "3", newer: "4", shelved: "5" },
    sessions: {
      "1": { title: null, createdAt: null, lastActivityAt: 9_000, archived: false },
      "3": { title: "Older", createdAt: 1_000, lastActivityAt: 2_000, archived: false },
      "4": { title: "Newer", createdAt: 1_500, lastActivityAt: 5_000, archived: false },
      "5": { title: "Shelved", createdAt: 1_200, lastActivityAt: 8_000, archived: true },
    },
  };

  const ids = (views: ReturnType<typeof listThreads>) => views.map((view) => view.thread);

  test("the root comes first, then the threads the most recently active first", () => {
    expect(
      ids(listThreads({ doc, legacy: {}, root: "1", live: idle, includeArchived: false })),
    ).toEqual([undefined, "newer", "older"]);
  });

  test("an archived thread is listed only when asked for", () => {
    const listed = listThreads({ doc, legacy: {}, root: "1", live: idle, includeArchived: true });
    expect(ids(listed)).toEqual([undefined, "shelved", "newer", "older"]);
    expect(listed.find((view) => view.thread === "shelved")?.archived).toBe(true);
  });

  test("a thread only the legacy table knows is listed, and the document wins a conflict", () => {
    const listed = listThreads({
      doc,
      legacy: { ancient: "2", older: "99" },
      root: "1",
      live: idle,
      includeArchived: false,
    });
    expect(ids(listed)).toEqual([undefined, "newer", "older", "ancient"]);
    expect(listed.find((view) => view.thread === "older")?.session).toBe("3");
    // It predates the record, so it says nothing it does not know.
    expect(listed.find((view) => view.thread === "ancient")).toEqual({
      thread: "ancient",
      session: "2",
      archived: false,
      busy: false,
      pendingApprovals: 0,
    });
  });

  test("a bot that never wrote the document still lists its root", () => {
    expect(
      listThreads({ doc: undefined, legacy: {}, root: "1", live: idle, includeArchived: false }),
    ).toEqual([{ session: "1", archived: false, busy: false, pendingApprovals: 0 }]);
  });

  test("each conversation carries its own run and its own approvals", () => {
    const listed = listThreads({
      doc,
      legacy: {},
      root: "1",
      live: { busy: new Set(["4"]), approvals: new Map([["1", 2]]) },
      includeArchived: false,
    });
    expect(listed.map((view) => [view.session, view.busy, view.pendingApprovals])).toEqual([
      ["1", false, 2],
      ["4", true, 0],
      ["3", false, 0],
    ]);
  });
});
