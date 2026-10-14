/**
 * bot-delegation — lets one bot hand work to another bot in the fleet.
 *
 * This module is the `delegate_to_bot` pi extension: a single `unsafe`
 * `delegate_to_bot` tool backed by the target bot's Durable Object. Extracted
 * from `src/index.ts` so the guards (unknown target, self-delegation) are pure
 * logic testable without a live DO, mirroring `src/executor-mcp.ts`'s shape
 * (header doc, config type, exported factory).
 *
 * ## Front door semantics
 *
 * `target` is validated against the live `bots.json` roster, so an unknown or
 * typo'd bot id comes back as a tool error instead of a Cloudflare RPC failure.
 * Self-delegation is rejected to avoid accidental runaway recursion; v1 also
 * warns the model never to hand work back to a bot that delegated to it
 * (mutual delegation livelocks on the 55s tool timeout).
 *
 * Admission is durable and at-most-once on the target by `operationId`: the same
 * id submitted twice returns the same receipt and never starts a second run. The
 * default response long-polls (bounded at {@link LONG_POLL_TIMEOUT_MS}) until
 * the submission settles. `wait=false` returns a receipt immediately; the only
 * way to check on it later is to call `delegate_to_bot` again with the same
 * `target` and `operationId` (the receipt's `operationId`), which is idempotent.
 * On timeout the caller gets a human-readable message naming the same
 * `target`/`operationId` retry — resubmitting the task with a fresh id would
 * double-submit the work and spend real money twice.
 *
 * ## Namespacing
 *
 * Model-supplied `operationId`s are namespaced as `delegate:<source>:<id>` so
 * they cannot collide with the target's own `http:`/`cron:`/`delegate:` ids or
 * reuse a remembered id for an unrelated task (which would silently return the
 * old settled answer).
 *
 * ## Approvals
 *
 * Approval links the target bot surfaces may appear in its answer text; this
 * module relays them upstream when present. The target bot owns resuming the
 * paused approval (via its own `executor_resume`); the source only forwards the
 * link, because the bridge opens a fresh MCP connection per call and resumes
 * are keyed server-side — letting the source resume would leave the target's
 * conversation unaware of the outcome.
 *
 * Public API (what `src/index.ts` imports):
 *
 *   import { createBotDelegation } from "./bot-delegation.ts";
 *   registry.install(createBotDelegation({ env, sourceBotId: botId }));
 */

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Extension, ToolExecutionResult } from "@earendil-works/pi-durable";
import { loadBots } from "./bots.ts";
import { createDelegationPolicy } from "./services/delegation.ts";
import { LONG_POLL_TIMEOUT_MS } from "./constants.ts";
import { maybeApprovalNotice } from "./executor-mcp.ts";
import type { Env } from "./index.ts";
import * as Effect from "effect/Effect";

export type BotDelegationConfig = {
  readonly env: Env;
  readonly sourceBotId: string;
};

/**
 * Build the `delegate_to_bot` extension for one source bot. The source id is
 * baked into the closure so self-delegation and mutual-delegation guards work.
 */
export function createBotDelegation(config: BotDelegationConfig): Extension {
  const { env, sourceBotId } = config;
  return defineExtension({
    name: "bot-delegation",
    tools: [
      defineTool({
        name: "delegate_to_bot",
        description:
          "Hand a task to another bot in the fleet and get its answer. Validates the target against the declared roster. A bot cannot delegate to itself, and must never hand work back to a bot that delegated to it (mutual delegation livelocks). By default waits up to ~55s for the result. If the result is a timeout, call delegate_to_bot again with the same target and operationId to keep waiting; never resubmit the task with a new operationId. Set wait=false to receive a receipt immediately; to check on it later, call delegate_to_bot again with the same target and operationId. Approval links the target bot surfaces may appear in its answer text and should be relayed upstream. Idempotency key: reuse operationId to retry without double-running the task.",
        parameters: Type.Object({
          target: Type.String({ description: "Bot id to delegate to (from bots.json)." }),
          task: Type.String({ description: "The message/instructions to send to the target bot." }),
          operationId: Type.Optional(
            Type.String({ description: "Idempotency key; reuse to retry without double-running." }),
          ),
          whenBusy: Type.Optional(
            Type.Union([Type.Literal("followUp"), Type.Literal("steer")], {
              description: "How to place the task if the target is busy (default: followUp).",
            }),
          ),
          wait: Type.Optional(
            Type.Boolean({ description: "Long-poll for the result (default: true)." }),
          ),
        }),
        replay: "unsafe",
        execute: (args): Promise<ToolExecutionResult> =>
          Effect.runPromise(
            // SAFETY: the Effect result is typed as ToolExecutionResult
            Effect.gen(function* () {
              const bots = loadBots();
              if (!Object.hasOwn(bots, args.target)) {
                return {
                  output: [
                    {
                      type: "text",
                      text: `unknown bot "${args.target}". Declared bots: ${Object.keys(bots).join(", ")}`,
                    },
                  ],
                  isError: true,
                };
              }
              if (args.target === sourceBotId) {
                return {
                  output: [{ type: "text", text: "a bot cannot delegate to itself" }],
                  isError: true,
                };
              }
              const policy = createDelegationPolicy(bots);
              if (!policy.canDelegate(sourceBotId, args.target)) {
                const allowed = policy.allowedTargets(sourceBotId);
                return {
                  output: [
                    {
                      type: "text",
                      text: `bot "${sourceBotId}" is not allowed to delegate to "${args.target}" (not in delegatesTo: ${allowed.join(", ") || "(none)"})`,
                    },
                  ],
                  isError: true,
                };
              }
              const operationId = args.operationId
                ? `delegate:${sourceBotId}:${args.operationId}`
                : `delegate:${sourceBotId}:${crypto.randomUUID()}`;
              const whenBusy = args.whenBusy ?? "followUp";
              const stub = env.Bot.getByName(args.target);
              const receipt = yield* Effect.tryPromise({
                try: () => stub.submit(args.task, operationId, whenBusy),
                catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
              });
              if (args.wait === false) {
                return {
                  output: [
                    {
                      type: "text",
                      text: [
                        `Delegated to "${args.target}" (operationId ${receipt.operationId}).`,
                        "The task is now running. To wait for or fetch the result later, call",
                        `delegate_to_bot again with the same target "${args.target}" and`,
                        `operationId "${receipt.operationId}" (repeat the same task; the target`,
                        "will not run it twice).",
                      ].join(" "),
                    },
                  ],
                };
              }
              const result = yield* Effect.tryPromise({
                try: () => stub.wait(operationId, LONG_POLL_TIMEOUT_MS),
                catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
              });
              if (result.status === "timeout") {
                return {
                  output: [
                    {
                      type: "text",
                      text: [
                        `Timed out waiting for "${args.target}" after ~55s; the task is still running`,
                        `(operationId ${operationId}). Keep waiting by calling delegate_to_bot again`,
                        `with the same target "${args.target}" and operationId "${operationId}".`,
                        "Do NOT resubmit the task with a new operationId — that would",
                        "double-submit the work and spend real money twice.",
                      ].join(" "),
                    },
                  ],
                };
              }
              let text = result.text ?? JSON.stringify(result, null, 2);
              const notice = maybeApprovalNotice(text);
              if (notice !== null) text = `${notice}\n\n${text}`;
              return {
                output: [{ type: "text", text }],
                isError: result.status === "unanswered",
              };
            }).pipe(
              Effect.catch((cause) =>
                Effect.succeed({
                  output: [
                    {
                      type: "text",
                      text: `delegation to "${args.target}" failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                    },
                  ],
                  isError: true,
                }),
              ),
              // SAFETY: the Effect result is typed as ToolExecutionResult
            ) as Effect.Effect<ToolExecutionResult>,
          ),
      }),
    ],
  });
}
