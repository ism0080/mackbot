/**
 * status — one bot's status view.
 *
 * `/status` is the only route the triage home folds over, so it carries the two
 * facts the home cannot learn any other way: which approvals are pending and
 * which run is in flight. Deriving them from the SSE frames instead would mean
 * subscribing in order to discover whether to subscribe.
 */

import type { UsageState } from "@earendil-works/pi-durable";

import type { ModelRef, ThinkingLevel } from "./bots.ts";
import type { RunRow } from "./runs.ts";
import { streamViewOf } from "./runs.ts";
import { usageView } from "./web-contract.ts";
import type {
  ActiveRunView,
  ApprovalView,
  BotView,
  FailureView,
  PendingOperationView,
  TaskView,
} from "./web-contract.ts";

export interface StatusFacts {
  readonly id: string;
  readonly model: ModelRef;
  readonly thinkingLevel: ThinkingLevel | null;
  readonly busy: boolean;
  readonly pending: readonly PendingOperationView[];
  readonly usage: UsageState;
  readonly approvals: readonly ApprovalView[];
  readonly runs: readonly RunRow[];
  readonly activeRun?: { readonly run: RunRow; readonly cursor: number };
  /** What the harness reported and could not recover from, newest first. */
  readonly failures: readonly FailureView[];
  /** The work the harness still has live. */
  readonly tasks: readonly TaskView[];
}

/**
 * The run a client should attach to: the newest open run whose submission has
 * not settled. `pending` is pi's own answer to "is this still running", so a run
 * row left open by a settlement nobody observed cannot strand a client on a dead
 * stream.
 */
export const activeRunOf = (
  pending: readonly PendingOperationView[],
  runs: readonly RunRow[],
): RunRow | undefined => {
  const live = new Set(pending.map((operation) => operation.operationId));
  let chosen: RunRow | undefined;
  for (const run of runs) {
    if (run.status !== "running" || !live.has(run.operationId)) continue;
    if (chosen === undefined || run.ordinal > chosen.ordinal) chosen = run;
  }
  return chosen;
};

const activeRunView = (run: RunRow, cursor: number): ActiveRunView => ({
  ordinal: run.ordinal,
  inputs: run.inputs,
  startedAt: run.startedAt,
  session: run.sessionId,
  stream: streamViewOf(run.sessionId, run, cursor),
});

export const projectStatus = (facts: StatusFacts): BotView => ({
  id: facts.id,
  model: facts.model,
  thinkingLevel: facts.thinkingLevel,
  busy: facts.busy,
  pending: facts.pending,
  usage: usageView(facts.usage),
  approvals: facts.approvals,
  activeRun:
    facts.activeRun === undefined
      ? undefined
      : activeRunView(facts.activeRun.run, facts.activeRun.cursor),
  failures: facts.failures,
  tasks: facts.tasks,
});
