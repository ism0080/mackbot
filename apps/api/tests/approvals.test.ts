import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";

import {
  APPROVAL_RETENTION_MS,
  createApprovalStore,
  createApprovalWait,
  MAX_PENDING_APPROVALS,
  WAIT_DEADLINE_MS,
} from "../src/approvals.ts";
import type { ApprovalStoreOptions, ApprovalWaitInput, SettledApproval } from "../src/approvals.ts";
import type { AuditRecord } from "../src/audit-log.ts";
import { approvalOperationId, pausedCallAuditId } from "../src/operation.ts";
import type { SqlRow, SqlStorage, SqlValue } from "../src/sql.ts";

const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);

/** A Durable Object's SQLite, in memory. */
const memoryStorage = (): SqlStorage => {
  const db = new DatabaseSync(":memory:");
  return {
    sql: {
      exec: (query: string, ...bindings: SqlValue[]) => {
        // SAFETY: the stores bind only strings, numbers and nulls, which node:sqlite takes as they are.
        const rows = db.prepare(query).all(...(bindings as (string | number | null)[]));
        // SAFETY: node:sqlite hands back plain rows of SQLite values, the shape `SqlRow` describes.
        return { toArray: () => rows as SqlRow[] };
      },
    },
  };
};

type Submitted = { input: string; operationId: string; whenBusy: string; session: string };

const recorder = () => {
  const calls: Submitted[] = [];
  const submit = async (input: string, operationId: string, whenBusy: string, session: string) => {
    calls.push({ input, operationId, whenBusy, session });
    return { accepted: true };
  };
  return { calls, submit };
};

const setup = (options: Omit<ApprovalStoreOptions, "now"> = {}) => {
  let clock = T0;
  const waits: ApprovalWaitInput[] = [];
  const store = createApprovalStore(memoryStorage(), {
    startWait: (wait) => {
      waits.push(wait);
    },
    ...options,
    now: () => clock,
  });
  return {
    store,
    waits,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

const pause = (requestId: string, session = "7") => ({
  bot: "hermes",
  session,
  requestId,
  envelope: JSON.stringify({
    status: "approval-required",
    requestId,
    invocation: { path: "tools.mail.send", input: { to: "ada@example.com" } },
  }),
});

const approvalIdOf = (store: ReturnType<typeof setup>["store"], index = 0): string => {
  const approval = store.pending()[index];
  if (approval === undefined) throw new Error("no pending approval");
  return approval.approvalId;
};

describe("recordPaused", () => {
  test("a pause seen twice is one approval and one wait", () => {
    const { store, waits } = setup();
    expect(store.recordPaused(pause("req-1"))).toBe("recorded");
    expect(store.recordPaused(pause("req-1"))).toBe("known");
    expect(store.pending()).toHaveLength(1);
    expect(waits).toHaveLength(1);
    expect(store.pending()[0]?.toolPath).toBe("tools.mail.send");
  });

  test("a pending approval names the conversation it paused in", () => {
    const { store } = setup();
    store.recordPaused(pause("req-root", "1"));
    store.recordPaused(pause("req-thread", "4"));
    expect(store.pending().map((approval) => approval.session)).toEqual(["1", "4"]);
  });

  test("a bot cannot hold more than the cap of pending approvals", () => {
    const { store, waits } = setup();
    for (let index = 0; index < MAX_PENDING_APPROVALS; index += 1) {
      expect(store.recordPaused(pause(`req-${index}`))).toBe("recorded");
    }
    expect(store.recordPaused(pause("one-too-many"))).toBe("limited");
    expect(waits).toHaveLength(MAX_PENDING_APPROVALS);
    expect(store.pending()).toHaveLength(MAX_PENDING_APPROVALS);
    expect(store.stateOf("one-too-many").state).toBe("unknown");
  });

  test("a decided approval frees its place under the cap", async () => {
    const { store } = setup();
    for (let index = 0; index < MAX_PENDING_APPROVALS; index += 1) {
      store.recordPaused(pause(`req-${index}`));
    }
    await store.decide(approvalIdOf(store), { action: "deny" }, recorder().submit);
    expect(store.recordPaused(pause("next"))).toBe("recorded");
  });
});

describe("decide", () => {
  test("records the decision with its content and steers it", async () => {
    const { store } = setup();
    store.recordPaused(pause("req-1", "42"));
    const approvalId = approvalIdOf(store);
    const { calls, submit } = recorder();
    const decided = await store.decide(
      approvalId,
      { action: "allow", content: { to: "ada@example.com" } },
      submit,
    );
    expect(decided).toEqual({ approvalId, bot: "hermes", status: "allowed", decidedAt: T0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.session).toBe("42");
    expect(calls[0]?.whenBusy).toBe("steer");
    expect(calls[0]?.input).toContain('{"action":"accept","content":{"to":"ada@example.com"}}');
    expect(store.stateOf("req-1")).toEqual({
      state: "approved",
      content: { to: "ada@example.com" },
      resumed: false,
    });
    expect(store.pending()).toHaveLength(0);
  });

  test("the same decision again re-delivers the steer instead of failing", async () => {
    const { store, advance } = setup();
    store.recordPaused(pause("req-1"));
    const approvalId = approvalIdOf(store);
    const { calls, submit } = recorder();
    const first = await store.decide(approvalId, { action: "allow", content: { n: 1 } }, submit);
    advance(5_000);
    const again = await store.decide(approvalId, { action: "allow", content: { n: 1 } }, submit);
    expect(again).toEqual(first);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.operationId).toBe(calls[0]?.operationId);
  });

  test("a different decision cannot overturn the first", async () => {
    const { store } = setup();
    store.recordPaused(pause("req-1"));
    const approvalId = approvalIdOf(store);
    const { calls, submit } = recorder();
    await store.decide(approvalId, { action: "allow" }, submit);
    expect(await store.decide(approvalId, { action: "deny" }, submit)).toBeUndefined();
    expect(
      await store.decide(approvalId, { action: "allow", content: { extra: "x" } }, submit),
    ).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(store.stateOf("req-1").state).toBe("approved");
  });

  test("a steer that failed is recovered by repeating the decision", async () => {
    const { store } = setup();
    store.recordPaused(pause("req-1"));
    const approvalId = approvalIdOf(store);
    const failing = async () => {
      throw new Error("the conversation was busy restarting");
    };
    await expect(store.decide(approvalId, { action: "deny" }, failing)).rejects.toThrow();
    expect(store.stateOf("req-1").state).toBe("denied");
    const { calls, submit } = recorder();
    expect(await store.decide(approvalId, { action: "deny" }, submit)).toBeDefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toContain('{"action":"decline"}');
  });

  test("a decision already carried out by a resume is not steered again", async () => {
    const { store } = setup();
    store.recordPaused(pause("req-1"));
    const approvalId = approvalIdOf(store);
    const { calls, submit } = recorder();
    await store.decide(approvalId, { action: "allow" }, submit);
    expect(store.claimResume("req-1")).toBe(true);
    expect(await store.decide(approvalId, { action: "allow" }, submit)).toBeDefined();
    expect(calls).toHaveLength(1);
  });

  test("an unknown approval cannot be decided", async () => {
    const { store } = setup();
    expect(await store.decide("nope", { action: "allow" }, recorder().submit)).toBeUndefined();
  });
});

describe("claimResume", () => {
  test("a decision admits exactly one resume", async () => {
    const { store } = setup();
    store.recordPaused(pause("req-1"));
    await store.decide(approvalIdOf(store), { action: "allow" }, recorder().submit);
    expect(store.claimResume("req-1")).toBe(true);
    expect(store.claimResume("req-1")).toBe(false);
    expect(store.stateOf("req-1").resumed).toBe(true);
  });

  test("an undecided or unknown approval cannot be claimed", () => {
    const { store } = setup();
    store.recordPaused(pause("req-1"));
    expect(store.claimResume("req-1")).toBe(false);
    expect(store.claimResume("never-seen")).toBe(false);
    expect(store.stateOf("req-1").state).toBe("pending");
  });
});

describe("deliver", () => {
  test("carries the human's form content, not only the action", async () => {
    const wait = recorder();
    const { store } = setup({ submit: wait.submit });
    store.recordPaused(pause("req-1"));
    const approvalId = approvalIdOf(store);
    await store.decide(
      approvalId,
      { action: "allow", content: { to: "ada@example.com", cc: ["bob"] } },
      recorder().submit,
    );
    expect(await store.deliver(approvalId)).toBe("delivered");
    expect(wait.calls[0]?.input).toContain(
      '{"action":"accept","content":{"to":"ada@example.com","cc":["bob"]}}',
    );
  });

  test("an undecided approval is still pending", async () => {
    const wait = recorder();
    const { store } = setup({ submit: wait.submit });
    store.recordPaused(pause("req-1"));
    expect(await store.deliver(approvalIdOf(store))).toBe("pending");
    expect(wait.calls).toHaveLength(0);
  });

  test("a decision a resume already carried out is not steered again", async () => {
    const wait = recorder();
    const { store } = setup({ submit: wait.submit });
    store.recordPaused(pause("req-1"));
    const approvalId = approvalIdOf(store);
    await store.decide(approvalId, { action: "allow" }, recorder().submit);
    store.claimResume("req-1");
    expect(await store.deliver(approvalId)).toBe("delivered");
    expect(wait.calls).toHaveLength(0);
  });
});

describe("expiry", () => {
  test("an approval past its deadline is expired everywhere", async () => {
    const wait = recorder();
    const { store, advance } = setup({ submit: wait.submit });
    store.recordPaused(pause("req-1"));
    const approvalId = approvalIdOf(store);
    advance(WAIT_DEADLINE_MS - 1);
    expect(store.pending()).toHaveLength(1);
    advance(1);
    expect(store.pending()).toHaveLength(0);
    expect(store.stateOf("req-1").state).toBe("unknown");
    expect(await store.decide(approvalId, { action: "allow" }, wait.submit)).toBeUndefined();
    expect(await store.deliver(approvalId)).toBe("unknown");
    expect(wait.calls).toHaveLength(0);
  });

  test("expire leaves a decided approval alone", async () => {
    const { store } = setup();
    store.recordPaused(pause("decided"));
    store.recordPaused(pause("undecided"));
    const [first, second] = store.pending();
    await store.decide(first!.approvalId, { action: "allow" }, recorder().submit);
    store.expire(first!.approvalId);
    store.expire(second!.approvalId);
    expect(store.stateOf("decided").state).toBe("approved");
    expect(store.stateOf("undecided").state).toBe("unknown");
  });

  test("the wait that gives up marks its approval expired", async () => {
    const { store, waits } = setup();
    store.recordPaused(pause("req-1"));
    const input = waits[0]!;
    const commits: string[] = [];
    const wait = createApprovalWait(store).definition.phases.wait;
    const runtime = {
      now: () => input.deadline,
      commit: async (change: () => { readonly status: string }) => {
        commits.push(change().status);
      },
      sleepUntil: async () => {
        throw new Error("the wait should not sleep past its deadline");
      },
    };
    await wait(
      // SAFETY: the wait phase reads only the task's input.
      { input } as never,
      // SAFETY: the wait phase uses only `now`, `commit` and `sleepUntil`.
      runtime as never,
      // SAFETY: the context only passes through to `commit`.
      {} as never,
    );
    expect(commits).toEqual(["terminal"]);
    expect(store.stateOf("req-1").state).toBe("unknown");
    expect(store.pending()).toHaveLength(0);
  });
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the phone channel", () => {
  test("is told about a new approval once, with its wait's deadline", async () => {
    const recorded: { approvalId: string; deadline: number }[] = [];
    const { store } = setup({
      onRecorded: (approval, deadline) => {
        recorded.push({ approvalId: approval.approvalId, deadline });
      },
    });
    store.recordPaused(pause("req-1"));
    store.recordPaused(pause("req-1"));
    await flush();
    expect(recorded).toEqual([
      { approvalId: approvalIdOf(store), deadline: T0 + WAIT_DEADLINE_MS },
    ]);
  });

  test("a hook that throws does not fail the pause", () => {
    const { store } = setup({
      onRecorded: () => {
        throw new Error("phone unreachable");
      },
    });
    expect(store.recordPaused(pause("req-1"))).toBe("recorded");
  });

  test("an answer from the phone is decided and steered by the wait", async () => {
    const wait = recorder();
    const settled: SettledApproval[] = [];
    const { store } = setup({
      submit: wait.submit,
      answerOf: async () => ({ action: "deny" }),
      onSettled: (approval) => {
        settled.push(approval);
      },
    });
    store.recordPaused(pause("req-1"));
    const approvalId = approvalIdOf(store);
    expect(await store.deliver(approvalId)).toBe("delivered");
    await flush();
    expect(store.stateOf("req-1").state).toBe("denied");
    expect(wait.calls[0]?.input).toContain('{"action":"decline"}');
    expect(settled).toEqual([
      { approvalId, bot: "hermes", how: "decided", via: "hark", status: "denied" },
    ]);
  });

  test("no answer yet, or a phone that fails, leaves the approval pending", async () => {
    const wait = recorder();
    const answers = [
      async () => undefined,
      async () => {
        throw new Error("Executor is down");
      },
    ];
    for (const answerOf of answers) {
      const { store } = setup({ submit: wait.submit, answerOf });
      store.recordPaused(pause("req-1"));
      expect(await store.deliver(approvalIdOf(store))).toBe("pending");
      expect(store.stateOf("req-1").state).toBe("pending");
    }
    expect(wait.calls).toHaveLength(0);
  });

  test("an approval decided in the app is not asked about again, and is settled via the app", async () => {
    let asked = 0;
    const settled: SettledApproval[] = [];
    const { store } = setup({
      submit: recorder().submit,
      answerOf: async () => {
        asked += 1;
        return { action: "allow" };
      },
      onSettled: (approval) => {
        settled.push(approval);
      },
    });
    store.recordPaused(pause("req-1"));
    const approvalId = approvalIdOf(store);
    await store.decide(approvalId, { action: "deny" }, recorder().submit);
    await store.deliver(approvalId);
    await flush();
    expect(asked).toBe(0);
    expect(store.stateOf("req-1").state).toBe("denied");
    expect(settled).toEqual([
      { approvalId, bot: "hermes", how: "decided", via: "app", status: "denied" },
    ]);
  });

  test("an expiry is announced once, and only for a pending approval", async () => {
    const settled: SettledApproval[] = [];
    const { store } = setup({
      onSettled: (approval) => {
        settled.push(approval);
      },
    });
    store.recordPaused(pause("req-1"));
    const approvalId = approvalIdOf(store);
    store.expire(approvalId);
    store.expire(approvalId);
    await flush();
    expect(settled).toEqual([{ approvalId, how: "expired" }]);
  });
});

describe("prune", () => {
  test("drops finished approvals past retention and keeps the rest", async () => {
    const { store, advance } = setup();
    store.recordPaused(pause("old"));
    await store.decide(approvalIdOf(store), { action: "allow" }, recorder().submit);
    advance(APPROVAL_RETENTION_MS + 1);
    store.recordPaused(pause("fresh"));
    store.prune();
    expect(store.stateOf("old").state).toBe("unknown");
    expect(store.stateOf("fresh").state).toBe("pending");
    // The row is gone, not merely hidden: the requestId can be recorded again.
    expect(store.recordPaused(pause("old"))).toBe("recorded");
  });
});

describe("audit", () => {
  /** A store whose audit rows are collected, kinds first. */
  const audited = (options: Omit<ApprovalStoreOptions, "now" | "audit"> = {}) => {
    const records: AuditRecord[] = [];
    const rig = setup({ ...options, audit: (record) => records.push(record) });
    return { ...rig, records, kinds: () => records.map((record) => record.kind) };
  };

  test("a recorded pause is requested once, under the steer's operation, without its draft", () => {
    const { store, records } = audited();
    store.recordPaused(pause("req-1", "42"));
    store.recordPaused(pause("req-1", "42"));
    const approvalId = approvalIdOf(store);
    expect(records).toEqual([
      {
        kind: "approval.requested",
        operationId: approvalOperationId(approvalId),
        detail: { approvalId, toolPath: "tools.mail.send", session: "42" },
      },
    ]);
    expect(JSON.stringify(records)).not.toContain("ada@example.com");
  });

  test("a pause past the cap is audited as limited, by its request id", () => {
    const { store, records } = audited();
    for (let index = 0; index < MAX_PENDING_APPROVALS; index += 1) {
      store.recordPaused(pause(`req-${index}`));
    }
    store.recordPaused(pause("one-too-many"));
    expect(records.at(-1)).toEqual({
      kind: "approval.limited",
      operationId: pausedCallAuditId("one-too-many"),
      detail: { session: "7", pending: MAX_PENDING_APPROVALS },
    });
  });

  test("a decision records its action and channel, never its form content", async () => {
    const { store, records } = audited();
    store.recordPaused(pause("req-1"));
    const approvalId = approvalIdOf(store);
    await store.decide(
      approvalId,
      { action: "allow", content: { to: "ada@example.com" } },
      recorder().submit,
    );
    expect(records.at(-1)).toEqual({
      kind: "approval.decided",
      operationId: approvalOperationId(approvalId),
      detail: { approvalId, action: "allow", withContent: true, channel: "http" },
    });
    expect(JSON.stringify(records)).not.toContain("ada@example.com");
  });

  test("a decision made on the phone is audited with the hark channel", async () => {
    const { store, records } = audited({
      submit: recorder().submit,
      answerOf: async () => ({ action: "allow" }),
    });
    store.recordPaused(pause("req-1"));
    const approvalId = approvalIdOf(store);
    await store.deliver(approvalId);
    expect(records.find((record) => record.kind === "approval.decided")).toEqual({
      kind: "approval.decided",
      operationId: approvalOperationId(approvalId),
      detail: { approvalId, action: "allow", withContent: false, channel: "hark" },
    });
  });

  test("a repeated decision is a redelivery, and one a resume carried out is nothing", async () => {
    const { store, kinds } = audited();
    store.recordPaused(pause("req-1"));
    const approvalId = approvalIdOf(store);
    const { submit } = recorder();
    await store.decide(approvalId, { action: "deny" }, submit);
    await store.decide(approvalId, { action: "deny" }, submit);
    store.claimResume("req-1");
    await store.decide(approvalId, { action: "deny" }, submit);
    expect(kinds()).toEqual([
      "approval.requested",
      "approval.decided",
      "approval.redelivered",
      "approval.resumed",
    ]);
  });

  test("the resume is audited once, with the decision it spent", async () => {
    const { store, records } = audited();
    store.recordPaused(pause("req-1"));
    const approvalId = approvalIdOf(store);
    await store.decide(approvalId, { action: "allow" }, recorder().submit);
    store.claimResume("req-1");
    store.claimResume("req-1");
    expect(records.filter((record) => record.kind === "approval.resumed")).toEqual([
      {
        kind: "approval.resumed",
        operationId: approvalOperationId(approvalId),
        detail: { approvalId, status: "allowed" },
      },
    ]);
  });

  test("the wait's delivery is audited", async () => {
    const { store, kinds } = audited({ submit: recorder().submit });
    store.recordPaused(pause("req-1"));
    const approvalId = approvalIdOf(store);
    await store.decide(approvalId, { action: "allow" }, recorder().submit);
    await store.deliver(approvalId);
    expect(kinds().at(-1)).toBe("approval.delivered");
  });

  test("each expiry is audited once, whichever path expired it", () => {
    const { store, records, advance } = audited();
    store.recordPaused(pause("by-wait"));
    store.recordPaused(pause("by-deadline"));
    const [byWait, byDeadline] = store.pending();
    store.expire(byWait!.approvalId);
    store.expire(byWait!.approvalId);
    advance(WAIT_DEADLINE_MS);
    store.pending();
    store.pending();
    expect(records.filter((record) => record.kind === "approval.expired")).toEqual([
      {
        kind: "approval.expired",
        operationId: approvalOperationId(byWait!.approvalId),
        detail: { approvalId: byWait!.approvalId, by: "wait" },
      },
      {
        kind: "approval.expired",
        operationId: approvalOperationId(byDeadline!.approvalId),
        detail: { approvalId: byDeadline!.approvalId, by: "deadline" },
      },
    ]);
  });
});
