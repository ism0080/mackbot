import type { JsonValue } from "@earendil-works/pi-ai";
import type { SubmissionRecord, Task, ToolExecutionResult } from "@earendil-works/pi-durable";
import { describe, expect, test, vi } from "vitest";

import type { BotConfig } from "@mackbot/contract";

import type { AuditRecord } from "../src/audit-log.ts";
import {
  MAX_DELEGATION_DEPTH,
  createBotDelegation,
  refuseDelegation,
  runDelegationChain,
} from "../src/bot-delegation.ts";
import type { BotDelegationConfig } from "../src/bot-delegation.ts";
import type { WaitResult } from "../src/env.ts";
import { delegateTaskOperationId, delegationChainOf } from "../src/operation.ts";

const bot = (overrides: Partial<BotConfig> = {}): BotConfig => ({
  model: "deepseek-v4-pro",
  systemPrompt: "You are a test bot.",
  ...overrides,
});

const fleet = { alpha: bot(), beta: bot(), gamma: bot(), delta: bot(), epsilon: bot() };

/** One input submission of a conversation, in the state the harness reports it. */
const input = (requestId: string, status: "queued" | "placed" | "done"): SubmissionRecord =>
  // SAFETY: a structural stand-in for pi's record; ids are branded numbers.
  ({
    id: 1,
    conversationId: 1,
    type: "input",
    status,
    entry: status === "queued" ? undefined : 2,
    answer: status === "done" ? 3 : undefined,
    requestId,
  }) as SubmissionRecord;

describe("runDelegationChain", () => {
  test("a run answering a person has no chain", () => {
    expect(runDelegationChain([input("http:abc", "placed")])).toEqual([]);
  });

  test("reads the chain from the inputs the run is answering", () => {
    const requestId = delegateTaskOperationId("beta", "4", ["alpha"]);
    expect(runDelegationChain([input(requestId, "placed")])).toEqual(["alpha", "beta"]);
  });

  test("ignores inputs the run is not answering", () => {
    const queued = delegateTaskOperationId("alpha", "1");
    const done = delegateTaskOperationId("gamma", "2");
    expect(runDelegationChain([input(queued, "queued"), input(done, "done")])).toEqual([]);
  });

  test("merges the chains of every input one run answers, each bot once", () => {
    expect(
      runDelegationChain([
        input(delegateTaskOperationId("beta", "1", ["alpha"]), "placed"),
        input(delegateTaskOperationId("gamma", "2", ["alpha"]), "placed"),
      ]),
    ).toEqual(["alpha", "beta", "gamma"]);
  });
});

describe("refuseDelegation", () => {
  const request = (target: string, chain: readonly string[] = [], roster = fleet) => ({
    roster,
    source: "beta",
    target,
    chain,
  });

  test("allows a first hand-off to a declared bot", () => {
    expect(refuseDelegation(request("gamma"))).toBeUndefined();
  });

  test("refuses an undeclared bot, and a prototype key is not a bot", () => {
    expect(refuseDelegation(request("ghost"))).toEqual({
      reason: "unknown-bot",
      message: expect.stringContaining('unknown bot "ghost"'),
    });
    expect(refuseDelegation(request("constructor"))?.reason).toBe("unknown-bot");
  });

  test("refuses self-delegation", () => {
    expect(refuseDelegation(request("beta"))?.reason).toBe("self");
  });

  test("refuses handing work back to a bot it came from", () => {
    const refusal = refuseDelegation(request("alpha", ["alpha"]));
    expect(refusal?.reason).toBe("loop");
    expect(refusal?.message).toContain("alpha -> beta");
  });

  test("refuses a cycle further up the chain", () => {
    expect(refuseDelegation(request("alpha", ["alpha", "delta"]))?.reason).toBe("loop");
  });

  test(`allows up to ${MAX_DELEGATION_DEPTH} hand-offs and refuses the next`, () => {
    const full = ["alpha", "delta", "epsilon"].slice(0, MAX_DELEGATION_DEPTH - 1);
    expect(refuseDelegation(request("gamma", full))).toBeUndefined();
    const over = ["alpha", "delta", "epsilon"].slice(0, MAX_DELEGATION_DEPTH);
    expect(refuseDelegation(request("gamma", over))).toEqual({
      reason: "depth",
      message: expect.stringContaining(`the limit is ${MAX_DELEGATION_DEPTH}`),
    });
  });

  test("an absent delegatesTo allows any bot; a list allows only its own", () => {
    expect(refuseDelegation(request("delta"))).toBeUndefined();
    const listed = { ...fleet, beta: bot({ delegatesTo: ["gamma"] }) };
    expect(refuseDelegation(request("gamma", [], listed))).toBeUndefined();
    expect(refuseDelegation(request("delta", [], listed))).toEqual({
      reason: "allowlist",
      message: expect.stringContaining("not in delegatesTo: gamma"),
    });
  });

  test("an empty delegatesTo allows none", () => {
    const none = { ...fleet, beta: bot({ delegatesTo: [] }) };
    expect(refuseDelegation(request("gamma", [], none))?.message).toContain("(none)");
  });
});

/** The parts of a delegation test the test steers between attempts. */
interface RigState {
  roster: Readonly<Record<string, BotConfig>>;
  /** What the target's next wait does; `evict` never returns, as an isolate that died mid-wait. */
  next: WaitResult["status"] | "evict" | "fail";
  waits: number;
}

/** The reporter the tool starts, by its input. */
type ReporterTask = Task<ReportInput, { readonly phase: string }, null, object>;

/** What the tool hands the reporter it starts. */
interface ReportInput {
  readonly target: string;
  readonly operationId: string;
}

describe("delegate_to_bot", () => {
  const EXECUTOR_URL = "https://executor.example/org/acme/mcp";
  const EXECUTOR_TOKEN = "pat_do_not_leak";

  /**
   * One delegating bot, `beta`, and a target whose admission is idempotent on
   * the operation id, as pi's is. A call's task memos outlive an attempt, so a
   * second attempt under the same task id is a replay of the first.
   */
  const rig = (placed: readonly string[] = []) => {
    const state: RigState = { roster: fleet, next: "done", waits: 0 };
    const held = new Set<string>();
    const submits: { readonly operationId: string; readonly accepted: boolean }[] = [];
    const reporters: ReportInput[] = [];
    const audits: AuditRecord[] = [];
    const memos = new Map<number, Map<string, JsonValue>>();
    const env = {
      EXECUTOR_URL,
      EXECUTOR_TOKEN,
      Registry: { getByName: () => ({ roster: async () => state.roster }) },
      Bot: {
        getByName: () => ({
          submit: async (_text: string, operationId: string) => {
            const accepted = !held.has(operationId);
            held.add(operationId);
            submits.push({ operationId, accepted });
            return { operationId, accepted };
          },
          wait: async (operationId: string): Promise<WaitResult> => {
            state.waits += 1;
            if (state.next === "evict") return await new Promise<never>(() => undefined);
            if (state.next === "fail") {
              throw new Error(`POST ${EXECUTOR_URL} failed: Bearer ${EXECUTOR_TOKEN}`);
            }
            return { operationId, session: "root", status: state.next, text: "answered" };
          },
        }),
      },
    };
    const config: BotDelegationConfig = {
      // SAFETY: the tool reaches only these bindings.
      env: env as never,
      sourceBotId: "beta",
      submissions: async () => placed.map((requestId) => input(requestId, "placed")),
      audit: (record) => audits.push(record),
    };
    const tool = createBotDelegation(config).tools?.[0];
    if (tool === undefined) throw new Error("the extension has no tool");
    const memo =
      (taskId: number) =>
      async (name: string, ...rest: readonly JsonValue[]) => {
        const stored = memos.get(taskId) ?? new Map<string, JsonValue>();
        memos.set(taskId, stored);
        const [candidate] = rest;
        if (rest.length === 2 && candidate !== undefined && !stored.has(name)) {
          stored.set(name, candidate);
        }
        return stored.get(name);
      };
    /** One attempt of the call whose durable task is `taskId`. */
    const attempt = (args: { target?: string; task?: string; wait?: boolean } = {}, taskId = 42) =>
      tool.execute(
        { target: "gamma", task: "draft the quarterly letter", ...args },
        // SAFETY: the tool reads only these fields of its api.
        {
          taskId,
          conversationId: 1,
          memo: memo(taskId),
          createTask: async (_task: ReporterTask, report: ReportInput) => {
            reporters.push(report);
            return 7;
          },
        } as never,
        // SAFETY: the fakes above read nothing from the context.
        {} as never,
      );
    /** The first attempt, cut off while it waits on the target. */
    const evicted = async (taskId = 42) => {
      state.next = "evict";
      void attempt({}, taskId);
      await vi.waitUntil(() => state.waits === 1);
    };
    const textOf = (result: ToolExecutionResult) =>
      result.output?.map((item) => (item.type === "text" ? item.text : "")).join("") ?? "";
    return { state, held, submits, reporters, audits, attempt, evicted, textOf };
  };

  test("carries the run's chain into the operation it submits", async () => {
    const { attempt, submits } = rig([delegateTaskOperationId("alpha", "7")]);
    const result = await attempt();
    expect(result.isError).toBe(false);
    expect(submits).toHaveLength(1);
    expect(delegationChainOf(submits[0]?.operationId ?? "")).toEqual(["alpha", "beta"]);
  });

  test("refuses to hand the work back, submits nothing, and audits why", async () => {
    const { attempt, submits, audits } = rig([delegateTaskOperationId("alpha", "7")]);
    const result = await attempt({ target: "alpha" });
    expect(result.isError).toBe(true);
    expect(submits).toEqual([]);
    expect(audits).toEqual([
      {
        kind: "delegation.refused",
        operationId: delegateTaskOperationId("beta", "42", ["alpha"]),
        detail: { target: "alpha", reason: "loop", chain: ["alpha", "beta"] },
      },
    ]);
  });

  test("a replay submits under the operation its first attempt did, and the target holds it once", async () => {
    const { evicted, attempt, submits, held, state } = rig();
    await evicted();
    state.next = "done";
    await attempt();
    expect(submits).toEqual([
      { operationId: delegateTaskOperationId("beta", "42"), accepted: true },
      { operationId: delegateTaskOperationId("beta", "42"), accepted: false },
    ]);
    expect(held.size).toBe(1);
  });

  test("another call is another delegation", async () => {
    const { attempt, held } = rig();
    await attempt({}, 42);
    await attempt({}, 43);
    expect([...held]).toEqual([
      delegateTaskOperationId("beta", "42"),
      delegateTaskOperationId("beta", "43"),
    ]);
  });

  test("a replay after the target settled returns the settled answer", async () => {
    const { evicted, attempt, state, audits, textOf } = rig();
    await evicted();
    state.next = "done";
    const result = await attempt();
    expect(result.isError).toBe(false);
    expect(textOf(result)).toBe("answered");
    expect(audits.map((record) => record.kind)).toEqual([
      "delegation.requested",
      "delegation.delivered",
      "delegation.reattached",
      "delegation.delivered",
      "delegation.settled",
    ]);
    expect(audits.at(-1)?.detail).toEqual({
      target: "gamma",
      status: "done",
      reason: null,
      via: "call",
    });
  });

  test("a replay rejoins its operation even after the roster stopped allowing it", async () => {
    const { evicted, attempt, state, textOf } = rig();
    await evicted();
    state.roster = { ...fleet, beta: bot({ delegatesTo: [] }) };
    state.next = "done";
    const result = await attempt();
    expect(textOf(result)).toBe("answered");
  });

  test("a replay after the reporter took over returns the receipt and leaves the target alone", async () => {
    const { attempt, state, submits, reporters, audits, textOf } = rig();
    state.next = "timeout";
    expect(textOf(await attempt())).toContain("will arrive as a new message");
    expect(reporters).toHaveLength(1);
    // The result was never committed: the call runs again under the same task.
    const replay = await attempt();
    expect(textOf(replay)).toContain("will arrive as a new message");
    expect(submits).toHaveLength(1);
    expect(state.waits).toBe(1);
    expect(reporters).toHaveLength(1);
    expect(audits.at(-1)).toEqual({
      kind: "delegation.reattached",
      operationId: delegateTaskOperationId("beta", "42"),
      detail: { target: "gamma", reporter: "7" },
    });
  });

  test("audits the request with the chain and depth, never the task's text", async () => {
    const { attempt, audits } = rig([delegateTaskOperationId("alpha", "7")]);
    await attempt({ wait: false });
    expect(audits[0]).toEqual({
      kind: "delegation.requested",
      operationId: delegateTaskOperationId("beta", "42", ["alpha"]),
      detail: {
        target: "gamma",
        chain: ["alpha", "beta"],
        depth: 2,
        whenBusy: "followUp",
        wait: false,
        taskLength: "draft the quarterly letter".length,
      },
    });
    expect(audits.map((record) => record.kind)).toContain("delegation.backgrounded");
    expect(JSON.stringify(audits)).not.toContain("quarterly");
  });

  test("audits a failed delegation without the Executor's URL or token", async () => {
    const { attempt, state, audits } = rig();
    state.next = "fail";
    const result = await attempt();
    expect(result.isError).toBe(true);
    const failure = audits.find((record) => record.kind === "delegation.failed");
    expect(failure?.operationId).toBe(delegateTaskOperationId("beta", "42"));
    expect(JSON.stringify(failure)).not.toContain(EXECUTOR_TOKEN);
    expect(JSON.stringify(failure)).not.toContain("executor.example");
  });
});
