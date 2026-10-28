/**
 * status — one bot's status view.
 *
 * `/status` is the only route the triage home folds over, so it carries the two
 * facts the home cannot learn any other way: which approvals are pending and
 * which run is in flight. Deriving them from the SSE frames instead would mean
 * subscribing in order to discover whether to subscribe.
 *
 * The in-flight run is pi's: `pi.live.run` names the generation task and the
 * submissions that run is answering, and `harness.inspect()` holds the task
 * record that dates it. Nothing here is stored beside those facts, so a run
 * that settles without anyone calling `wait()` cannot leave a stale row behind.
 */

import type { UsageState } from "@earendil-works/pi-durable";

import type {
  ActiveRunView,
  ApprovalView,
  BotView,
  FailureView,
  PendingOperationView,
  TaskView,
} from "@mackbot/contract";
import { usageView } from "@mackbot/contract";
import type { ModelRef } from "@mackbot/contract";
import type { ThinkingLevel } from "@mackbot/contract/catalog";

export interface StatusFacts {
  readonly id: string;
  readonly model: ModelRef;
  readonly thinkingLevel: ThinkingLevel | null;
  readonly busy: boolean;
  readonly pending: readonly PendingOperationView[];
  readonly usage: UsageState;
  readonly approvals: readonly ApprovalView[];
  /**
   * The run in flight, derived from `pi.live` and the harness inspection. The
   * caller builds it because only it can read those; this module is pure.
   */
  readonly activeRun?: ActiveRunView;
  /** What the harness reported and could not recover from, newest first. */
  readonly failures: readonly FailureView[];
  /** The work the harness still has live. */
  readonly tasks: readonly TaskView[];
}

export const projectStatus = (facts: StatusFacts): BotView => ({
  id: facts.id,
  model: facts.model,
  thinkingLevel: facts.thinkingLevel,
  busy: facts.busy,
  pending: facts.pending,
  usage: usageView(facts.usage),
  approvals: facts.approvals,
  activeRun: facts.activeRun,
  failures: facts.failures,
  tasks: facts.tasks,
});
