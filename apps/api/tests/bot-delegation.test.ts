import type { SubmissionRecord } from "@earendil-works/pi-durable";
import { describe, expect, test } from "vitest";

import type { BotConfig } from "@mackbot/contract";

import {
  MAX_DELEGATION_DEPTH,
  createBotDelegation,
  refuseDelegation,
  runDelegationChain,
} from "../src/bot-delegation.ts";
import type { BotDelegationConfig } from "../src/bot-delegation.ts";
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
    expect(refuseDelegation(request("ghost"))).toContain('unknown bot "ghost"');
    expect(refuseDelegation(request("constructor"))).toContain("unknown bot");
  });

  test("refuses self-delegation", () => {
    expect(refuseDelegation(request("beta"))).toContain("itself");
  });

  test("refuses handing work back to a bot it came from", () => {
    const refusal = refuseDelegation(request("alpha", ["alpha"]));
    expect(refusal).toContain("loop");
    expect(refusal).toContain("alpha -> beta");
  });

  test("refuses a cycle further up the chain", () => {
    expect(refuseDelegation(request("alpha", ["alpha", "delta"]))).toContain("loop");
  });

  test(`allows up to ${MAX_DELEGATION_DEPTH} hand-offs and refuses the next`, () => {
    const full = ["alpha", "delta", "epsilon"].slice(0, MAX_DELEGATION_DEPTH - 1);
    expect(refuseDelegation(request("gamma", full))).toBeUndefined();
    const over = ["alpha", "delta", "epsilon"].slice(0, MAX_DELEGATION_DEPTH);
    expect(refuseDelegation(request("gamma", over))).toContain(
      `the limit is ${MAX_DELEGATION_DEPTH}`,
    );
  });

  test("an absent delegatesTo allows any bot; a list allows only its own", () => {
    expect(refuseDelegation(request("delta"))).toBeUndefined();
    const listed = { ...fleet, beta: bot({ delegatesTo: ["gamma"] }) };
    expect(refuseDelegation(request("gamma", [], listed))).toBeUndefined();
    expect(refuseDelegation(request("delta", [], listed))).toContain("not in delegatesTo: gamma");
  });

  test("an empty delegatesTo allows none", () => {
    const none = { ...fleet, beta: bot({ delegatesTo: [] }) };
    expect(refuseDelegation(request("gamma", [], none))).toContain("(none)");
  });
});

describe("delegate_to_bot", () => {
  /** Run the tool once as `beta`, in a run answering `placed`. */
  const delegate = async (target: string, placed: readonly string[]) => {
    const submitted: string[] = [];
    const env = {
      Registry: { getByName: () => ({ roster: async () => fleet }) },
      Bot: {
        getByName: () => ({
          submit: async (_text: string, operationId: string) => {
            submitted.push(operationId);
            return { operationId, accepted: true };
          },
          wait: async () => ({ status: "done", text: "answered" }),
        }),
      },
    };
    const config: BotDelegationConfig = {
      // SAFETY: the tool reaches only these two bindings.
      env: env as never,
      sourceBotId: "beta",
      submissions: async () => placed.map((requestId) => input(requestId, "placed")),
    };
    const tool = createBotDelegation(config).tools?.[0];
    if (tool === undefined) throw new Error("the extension has no tool");
    // SAFETY: the tool reads only these fields of its api on a waited call.
    const api = { taskId: 42, conversationId: 1 } as never;
    // SAFETY: a waited call reads nothing from its context.
    const callContext = {} as never;
    const result = await tool.execute({ target, task: "do it" }, api, callContext);
    return { result, submitted };
  };

  test("carries the run's chain into the operation it submits", async () => {
    const { result, submitted } = await delegate("gamma", [delegateTaskOperationId("alpha", "7")]);
    expect(result.isError).toBe(false);
    expect(submitted).toHaveLength(1);
    expect(delegationChainOf(submitted[0] ?? "")).toEqual(["alpha", "beta"]);
  });

  test("refuses to hand the work back and submits nothing", async () => {
    const { result, submitted } = await delegate("alpha", [delegateTaskOperationId("alpha", "7")]);
    expect(result.isError).toBe(true);
    expect(submitted).toEqual([]);
  });
});
