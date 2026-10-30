import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import type { HookApi, ToolHooks } from "@earendil-works/pi-durable";
import { describe, expect, test } from "vitest";

import { createExecutorPolicy } from "../src/executor-policy.ts";
import type {
  ApprovalState,
  ApprovalStatus,
  ExecutorPolicyOptions,
} from "../src/executor-policy.ts";

/** A hook api whose memos live as long as one tool task: one per `fakeTask()`. */
const fakeTask = (): HookApi => {
  const memos = new Map<string, JsonValue>();
  const memo = async (name: string, ...rest: readonly JsonValue[]) => {
    const [candidate] = rest;
    if (rest.length === 2 && candidate !== undefined && !memos.has(name)) {
      memos.set(name, candidate);
    }
    return memos.get(name);
  };
  // SAFETY: the policy's hook reads only `memo` of its api.
  return { memo } as never;
};

const policy = (
  states: Readonly<Record<string, ApprovalState | ApprovalStatus>>,
  extra: Partial<ExecutorPolicyOptions> = {},
) => {
  const extension = createExecutorPolicy({
    approvalState: (requestId) => states[requestId] ?? "unknown",
    onCall: () => undefined,
    ...extra,
  });
  // SAFETY: the policy installs exactly one hook, on the tool task.
  const handlers = extension.hooks?.[0]?.handlers as Pick<ToolHooks, "beforeTool">;
  return async (args: JsonObject, task = fakeTask(), name = "executor_resume") =>
    handlers.beforeTool(
      { type: "toolCall", name, id: "call-1", arguments: args },
      task,
      // SAFETY: the hook passes the context through to `memo` and reads none of it.
      {} as never,
    );
};

const accept = (content?: JsonObject): JsonObject =>
  content === undefined ? { action: "accept" } : { action: "accept", content };

describe("executor_resume gate", () => {
  test("other tools pass untouched, whatever their arguments", async () => {
    const check = policy({});
    expect(
      await check({ requestId: "nobody-approved" }, fakeTask(), "executor_call"),
    ).toBeUndefined();
  });

  test("a resume without a usable requestId is refused", async () => {
    const check = policy({});
    expect((await check({ response: accept() }))?.block).toContain("(missing)");
    expect(await check({ requestId: 42, response: accept() })).toBeDefined();
  });

  test("a requestId the store never saw is refused", async () => {
    const check = policy({});
    expect((await check({ requestId: "invented", response: accept() }))?.block).toContain(
      "no human decision",
    );
  });

  test("a pending approval cannot be resumed before the human answers", async () => {
    const check = policy({ req: "pending" });
    expect((await check({ requestId: "req", response: accept() }))?.block).toContain("not decided");
  });

  test("an approved request resumes with the human's accept", async () => {
    const check = policy({ req: "approved" });
    expect(await check({ requestId: "req", response: accept() })).toBeUndefined();
  });

  describe("a denied request", () => {
    test("cannot be resumed without a response", async () => {
      const check = policy({ req: "denied" });
      expect(await check({ requestId: "req" })).toBeDefined();
    });

    test("cannot be accepted", async () => {
      const check = policy({ req: "denied" });
      expect((await check({ requestId: "req", response: accept() }))?.block).toContain("refused");
    });

    test("cannot be resumed with a malformed action", async () => {
      const check = policy({ req: "denied" });
      expect(await check({ requestId: "req", response: { action: "ACCEPT" } })).toBeDefined();
      expect(await check({ requestId: "req", response: "accept" })).toBeDefined();
    });

    test("ends with a decline or a cancel", async () => {
      expect(
        await policy({ req: "denied" })({ requestId: "req", response: { action: "decline" } }),
      ).toBeUndefined();
      expect(
        await policy({ req: "denied" })({ requestId: "req", response: { action: "cancel" } }),
      ).toBeUndefined();
    });
  });

  test("an approved request cannot be turned into a decline by omission", async () => {
    const check = policy({ req: "approved" });
    expect(await check({ requestId: "req" })).toBeDefined();
    expect(await check({ requestId: "req", response: { action: "decline" } })).toBeDefined();
  });

  describe("form content", () => {
    const submitted = { recipient: "ada@example.com", amount: 10, tags: ["a", "b"] };

    test("the human's own content passes, in any key order", async () => {
      const check = policy({ req: { state: "approved", content: submitted } });
      const reordered = { tags: ["a", "b"], amount: 10, recipient: "ada@example.com" };
      expect(await check({ requestId: "req", response: accept(reordered) })).toBeUndefined();
    });

    test("the model cannot substitute its own content", async () => {
      const check = policy({ req: { state: "approved", content: submitted } });
      const forged = { ...submitted, recipient: "mallory@example.com" };
      expect((await check({ requestId: "req", response: accept(forged) }))?.block).toContain(
        "form content",
      );
    });

    test("the model cannot drop content the human submitted", async () => {
      const check = policy({ req: { state: "approved", content: submitted } });
      expect(await check({ requestId: "req", response: accept() })).toBeDefined();
    });

    test("the model cannot add content to an approval that had none", async () => {
      const check = policy({ req: "approved" });
      expect(
        await check({ requestId: "req", response: accept({ amount: 1_000_000 }) }),
      ).toBeDefined();
    });

    test("array content must match element for element", async () => {
      const check = policy({ req: { state: "approved", content: { tags: ["a", "b"] } } });
      expect(
        await check({ requestId: "req", response: accept({ tags: ["b", "a"] }) }),
      ).toBeDefined();
    });
  });

  test("terms the human never saw are refused", async () => {
    const check = policy({ req: "approved" });
    expect(await check({ requestId: "req", response: accept(), persist: "always" })).toBeDefined();
    expect(
      await check({ requestId: "req", response: { action: "accept", persist: "always" } }),
    ).toBeDefined();
  });

  describe("one decision, one resume", () => {
    test("a second resume of the same requestId is refused", async () => {
      const check = policy({ req: "approved" });
      expect(await check({ requestId: "req", response: accept() })).toBeUndefined();
      expect((await check({ requestId: "req", response: accept() }))?.block).toContain(
        "already carried out",
      );
    });

    test("a rerun of the resume that claimed it is the same resume", async () => {
      const check = policy({ req: "approved" });
      const task = fakeTask();
      expect(await check({ requestId: "req", response: accept() }, task)).toBeUndefined();
      expect(await check({ requestId: "req", response: accept() }, task)).toBeUndefined();
    });

    test("the host's durable claim is the one spent", async () => {
      const claims: string[] = [];
      const check = policy(
        { req: "approved" },
        {
          claimResume: (requestId) => {
            claims.push(requestId);
            return claims.length === 1;
          },
        },
      );
      expect(await check({ requestId: "req", response: accept() })).toBeUndefined();
      expect(await check({ requestId: "req", response: accept() })).toBeDefined();
      expect(claims).toEqual(["req", "req"]);
    });

    test("a decision the store says was already resumed is refused", async () => {
      const check = policy({ req: { state: "approved", resumed: true } });
      expect(await check({ requestId: "req", response: accept() })).toBeDefined();
    });

    test("a refused resume does not spend the claim", async () => {
      const check = policy({ req: { state: "approved", content: { a: "1" } } });
      expect(await check({ requestId: "req", response: accept({ a: "2" }) })).toBeDefined();
      expect(await check({ requestId: "req", response: accept({ a: "1" }) })).toBeUndefined();
    });
  });
  describe("refusals reach the host", () => {
    test("each refused resume is reported with its requestId and reason, the block text aside", async () => {
      const refusals: unknown[] = [];
      const check = policy({ req: "pending" }, { onRefused: (refusal) => refusals.push(refusal) });
      const blocked = await check({ requestId: "req", response: accept() });
      await check({ response: accept() });
      expect(refusals).toEqual([
        { requestId: "req", reason: "a human has not decided on it yet." },
        { requestId: undefined, reason: "no requestId names an approval." },
      ]);
      expect(blocked).toEqual({ block: expect.stringContaining("not decided") });
    });

    test("an admitted resume and other tools report nothing", async () => {
      const refusals: unknown[] = [];
      const check = policy({ req: "approved" }, { onRefused: (refusal) => refusals.push(refusal) });
      await check({ requestId: "req", response: accept() });
      await check({ requestId: "anything" }, fakeTask(), "executor_call");
      expect(refusals).toEqual([]);
    });
  });
});
