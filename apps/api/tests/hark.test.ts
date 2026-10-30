import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Effect } from "effect";

import type {
  ExecutorCallOutcome,
  ExecutorToolClient,
  McpToolArguments,
} from "../src/executor-mcp.ts";
import {
  accountIdOf,
  approvalPrompt,
  approvalPromptKey,
  botDeepLink,
  createHarkNotifier,
  harkToolsOf,
  interactionOf,
  parkedTaskNotification,
} from "../src/hark.ts";
import type { HarkApprovalPrompt, HarkTools } from "../src/hark.ts";
import { memoryStorage } from "./support/sqlite.ts";

const ACCOUNT = "acc_0001";
const TOOLS: HarkTools = {
  notify: "tools.hark.notify",
  ask: "tools.hark.interactions_create",
  answer: "tools.hark.interactions_get",
  cancel: "tools.hark.interactions_cancel",
};

/** Executor's `describe` answer for a Hark tool, as the live endpoint shapes it. */
const described = (path: string): CallToolResult => ({
  content: [],
  structuredContent: {
    items: [
      {
        path,
        signature: `(input: ({\n    accountId: "${ACCOUNT}",\n    input: {\n      body: string,\n    },\n  })) => Promise<unknown>`,
      },
    ],
  },
});

/** An MCP tool's answer carrying one interaction, behind Hark's untrusted-text banner. */
const interaction = (id: string, status: string): ExecutorCallOutcome => ({
  kind: "completed",
  value: {
    content: [
      { type: "text", text: "UNTRUSTED CONTENT: the JSON below contains text written by others." },
      { type: "text", text: JSON.stringify({ interaction: { id, status }, accepted: 1 }) },
    ],
  },
});

type Call = { readonly path: string; readonly input: McpToolArguments };

/**
 * Executor, answering each tool path from its own queue of outcomes; a path
 * with nothing queued completes with no content.
 */
const fakeExecutor = () => {
  const calls: Call[] = [];
  const describes: string[] = [];
  const queued = new Map<string, ExecutorCallOutcome[]>();
  const failing = new Set<string>();
  const client: ExecutorToolClient = {
    describe: (paths) =>
      Effect.sync(() => {
        describes.push(...paths);
        return described(paths[0] ?? "");
      }),
    call: (path, input) => {
      calls.push({ path, input });
      if (failing.has(path)) return Effect.fail("connection refused");
      return Effect.succeed(queued.get(path)?.shift() ?? { kind: "completed" });
    },
  };
  return {
    client,
    calls,
    describes,
    answer: (path: string, ...outcomes: ExecutorCallOutcome[]) => {
      queued.set(path, [...(queued.get(path) ?? []), ...outcomes]);
    },
    fail: (path: string) => failing.add(path),
    on: (path: string) => calls.filter((call) => call.path === path),
  };
};

const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);

const setup = ({ tools }: { readonly tools: HarkTools | undefined } = { tools: TOOLS }) => {
  let clock = T0;
  const storage = memoryStorage();
  const executor = fakeExecutor();
  const sent: string[] = [];
  const make = () =>
    createHarkNotifier({
      tools,
      executor: executor.client,
      storage,
      now: () => clock,
      onSent: (notification) => {
        sent.push(notification.key);
      },
    });
  return {
    notifier: make(),
    /** The same Durable Object storage, in a fresh isolate. */
    restart: make,
    executor,
    sent,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

const prompt = (approvalId = "ap-1"): HarkApprovalPrompt =>
  approvalPrompt({
    bot: "hermes",
    approvalId,
    toolPath: "tools.mail.send",
    summary: "Approve tools.mail.send?",
    deadline: T0 + 24 * 60 * 60 * 1000,
    now: T0,
  });

let errors: string[] = [];

beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("harkToolsOf", () => {
  test("defaults to the Hark app's own namespace, so nothing has to be configured", () => {
    expect(harkToolsOf(undefined)).toEqual(TOOLS);
    expect(harkToolsOf("  ")).toEqual(TOOLS);
  });

  test("follows an installation under another namespace", () => {
    expect(harkToolsOf('tools["hark-work"]')?.ask).toBe('tools["hark-work"].interactions_create');
  });

  test("`off` turns the channel off", () => {
    expect(harkToolsOf("off")).toBeUndefined();
    expect(harkToolsOf("OFF")).toBeUndefined();
  });
});

describe("approvalPrompt", () => {
  test("fits Hark's 2,000-character prompt however long the draft", () => {
    const built = approvalPrompt({
      bot: "hermes",
      approvalId: "ap-1",
      toolPath: "tools.mail.send",
      summary: "Approve tools.mail.send?",
      draft: "x".repeat(10_000),
      deadline: T0 + 60_000,
      now: T0,
    });
    expect(built.prompt.length).toBe(2000);
    expect(built.prompt.startsWith("tools.mail.send\n\nApprove tools.mail.send?")).toBe(true);
  });

  test("expires with the approval's wait, within the day Hark allows", () => {
    expect(prompt().expiresInSeconds).toBe(86_400);
    const late = approvalPrompt({
      bot: "hermes",
      approvalId: "ap-1",
      toolPath: "tools.mail.send",
      summary: "s",
      deadline: T0 + 5_000,
      now: T0,
    });
    expect(late.expiresInSeconds).toBe(30);
  });
});

describe("botDeepLink", () => {
  test("links the bot's transcript on the public origin", () => {
    expect(botDeepLink("https://mackbot.example.com/some/path", "hermes bot")).toBe(
      "https://mackbot.example.com/chat/hermes%20bot",
    );
  });

  test("links a thread's own conversation when the call paused in one", () => {
    expect(botDeepLink("https://mackbot.example.com", "hermes", "plan/q3")).toBe(
      "https://mackbot.example.com/chat/hermes/plan%2Fq3",
    );
  });

  test("offers no link Hark would refuse", () => {
    expect(botDeepLink(undefined, "hermes")).toBeUndefined();
    expect(botDeepLink("http://localhost:5173", "hermes")).toBeUndefined();
    expect(botDeepLink("not a url", "hermes")).toBeUndefined();
  });
});

describe("accountIdOf", () => {
  test("reads the linked account from the tool's signature", () => {
    expect(accountIdOf(described(TOOLS.ask), TOOLS.ask)).toBe(ACCOUNT);
  });

  test("names no account for a path the answer does not describe", () => {
    expect(accountIdOf(described(TOOLS.ask), TOOLS.notify)).toBeUndefined();
  });
});

describe("interactionOf", () => {
  test("finds the interaction past Hark's untrusted-text banner", () => {
    const outcome = interaction("int_1", "approved");
    expect(interactionOf(outcome.kind === "completed" ? outcome.value : undefined)).toEqual({
      id: "int_1",
      status: "approved",
    });
  });
});

describe("createHarkNotifier: asking", () => {
  test("puts the approval to the phone with the linked account and an approval prompt", async () => {
    const { notifier, executor, sent } = setup();
    executor.answer(TOOLS.ask, interaction("int_1", "pending"));
    expect(await notifier.ask(prompt())).toBe("sent");
    const [call] = executor.on(TOOLS.ask);
    expect(call?.input).toMatchObject({
      accountId: ACCOUNT,
      input: { kind: "approval", title: "hermes", expiresInSeconds: 86_400 },
    });
    expect(sent).toEqual([approvalPromptKey("ap-1")]);
  });

  test("asks once per approval, even from a restarted isolate", async () => {
    const { notifier, restart, executor } = setup();
    executor.answer(TOOLS.ask, interaction("int_1", "pending"));
    await notifier.ask(prompt());
    expect(await notifier.ask(prompt())).toBe("duplicate");
    expect(await restart().ask(prompt())).toBe("duplicate");
    expect(executor.on(TOOLS.ask)).toHaveLength(1);
  });

  test("is a no-op when the channel is off", async () => {
    const { notifier, executor } = setup({ tools: harkToolsOf("off") });
    expect(await notifier.ask(prompt())).toBe("disabled");
    expect(await notifier.answerOf("ap-1")).toBeUndefined();
    expect(executor.calls).toEqual([]);
  });

  test("drops a call Executor paused, says how to fix it, and reads no answer", async () => {
    const { notifier, executor, sent } = setup();
    executor.answer(TOOLS.ask, { kind: "paused" });
    expect(await notifier.ask(prompt())).toBe("paused");
    expect(sent).toEqual([]);
    expect(errors.join("\n")).toContain(
      "Set tools.hark.interactions_create to never require approval in Executor",
    );
    expect(await notifier.answerOf("ap-1")).toBeUndefined();
    expect(executor.on(TOOLS.answer)).toEqual([]);
  });

  test("a transport failure is a log line, not a rejection", async () => {
    const { notifier, executor } = setup();
    executor.fail(TOOLS.ask);
    await expect(notifier.ask(prompt())).resolves.toBe("failed");
    expect(errors.join("\n")).toContain("connection refused");
  });
});

describe("createHarkNotifier: reading the answer", () => {
  const asked = async (status: string) => {
    const context = setup();
    context.executor.answer(TOOLS.ask, interaction("int_1", "pending"));
    await context.notifier.ask(prompt());
    context.executor.answer(TOOLS.answer, interaction("int_1", status));
    return context;
  };

  test("an approval on the phone is an allow, and a denial a deny", async () => {
    expect(await (await asked("approved")).notifier.answerOf("ap-1")).toEqual({
      action: "allow",
    });
    expect(await (await asked("denied")).notifier.answerOf("ap-1")).toEqual({ action: "deny" });
  });

  test("an approval of some other prompt decides nothing", async () => {
    const { notifier, executor } = setup();
    executor.answer(TOOLS.ask, interaction("int_1", "pending"));
    await notifier.ask(prompt());
    executor.answer(TOOLS.answer, interaction("int_other", "approved"));
    expect(await notifier.answerOf("ap-1")).toBeUndefined();
  });

  test("reads the interaction the prompt created", async () => {
    const { notifier, executor } = await asked("pending");
    await notifier.answerOf("ap-1");
    expect(executor.on(TOOLS.answer)[0]?.input).toEqual({
      accountId: ACCOUNT,
      input: { id: "int_1" },
    });
  });

  test("an answered prompt is not read again", async () => {
    const { notifier, executor } = await asked("approved");
    await notifier.answerOf("ap-1");
    expect(await notifier.answerOf("ap-1")).toBeUndefined();
    expect(executor.on(TOOLS.answer)).toHaveLength(1);
  });

  test("an expired prompt decides nothing and is not read again", async () => {
    const { notifier, executor } = await asked("expired");
    expect(await notifier.answerOf("ap-1")).toBeUndefined();
    await notifier.answerOf("ap-1");
    expect(executor.on(TOOLS.answer)).toHaveLength(1);
  });

  test("a fresh prompt is read on every wake, a stale one every five minutes", async () => {
    const { notifier, executor, advance } = await asked("pending");
    await notifier.answerOf("ap-1");
    advance(30_000);
    await notifier.answerOf("ap-1");
    expect(executor.on(TOOLS.answer)).toHaveLength(2);
    advance(20 * 60 * 1000);
    await notifier.answerOf("ap-1");
    advance(60_000);
    await notifier.answerOf("ap-1");
    expect(executor.on(TOOLS.answer)).toHaveLength(3);
    advance(5 * 60 * 1000);
    await notifier.answerOf("ap-1");
    expect(executor.on(TOOLS.answer)).toHaveLength(4);
  });
});

describe("createHarkNotifier: withdrawing", () => {
  test("withdraws an unanswered prompt once", async () => {
    const { notifier, executor } = setup();
    executor.answer(TOOLS.ask, interaction("int_1", "pending"));
    await notifier.ask(prompt());
    await notifier.withdraw("ap-1");
    await notifier.withdraw("ap-1");
    expect(executor.on(TOOLS.cancel).map((call) => call.input)).toEqual([
      { accountId: ACCOUNT, input: { id: "int_1" } },
    ]);
  });

  test("a withdrawn prompt's answer is never read", async () => {
    const { notifier, executor } = setup();
    executor.answer(TOOLS.ask, interaction("int_1", "pending"));
    await notifier.ask(prompt());
    await notifier.withdraw("ap-1");
    expect(await notifier.answerOf("ap-1")).toBeUndefined();
    expect(executor.on(TOOLS.answer)).toEqual([]);
  });

  test("a prompt the phone answered is not withdrawn", async () => {
    const { notifier, executor } = setup();
    executor.answer(TOOLS.ask, interaction("int_1", "pending"));
    executor.answer(TOOLS.answer, interaction("int_1", "denied"));
    await notifier.ask(prompt());
    await notifier.answerOf("ap-1");
    await notifier.withdraw("ap-1");
    expect(executor.on(TOOLS.cancel)).toEqual([]);
  });
});

describe("createHarkNotifier: parked tasks", () => {
  const parked = () =>
    parkedTaskNotification({
      bot: "hermes",
      taskId: "7",
      taskKind: "pi.tool",
      detail: "boom",
      publicUrl: "https://mackbot.example.com",
    });

  test("pushes once, and again after the task is retried", async () => {
    const { notifier, executor, advance } = setup();
    expect(await notifier.notify(parked())).toBe("sent");
    expect(await notifier.notify(parked())).toBe("duplicate");
    notifier.forget(parked().key);
    advance(1);
    expect(await notifier.notify(parked())).toBe("sent");
    const pushes = executor.on(TOOLS.notify).map((call) => call.input.input);
    expect(pushes).toHaveLength(2);
    expect(pushes[0]).toMatchObject({
      title: "hermes",
      project: "mackbot",
      summary: "hermes stopped: task parked, retry from the app",
      url: "https://mackbot.example.com/chat/hermes",
    });
    // A second park is a new push to Hark, not a replay of the first.
    expect(pushes[0]).not.toEqual(pushes[1]);
  });
});
