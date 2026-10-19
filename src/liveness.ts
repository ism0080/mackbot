/**
 * liveness — the harness's live work, projected for the status view.
 *
 * `/status` reports liveness from `harness.pending()` and `sessions.list()`,
 * which say that a bot is busy but not what it is busy with: a task whose
 * definition is missing, that is too old, or whose migration failed never
 * reaches the operator. pi's `harness.inspect()` carries every live task
 * with the state the scheduler sees it in, and this module turns that
 * inspection into the `TaskView`s the status view already speaks.
 *
 * Pure: it reads one inspection and returns views, so the same harness state
 * always projects to the same list.
 */

import type { HarnessInspection } from "@earendil-works/pi-durable";
import * as Schema from "effect/Schema";

import type { TaskView } from "./web-contract.ts";

type InspectedTask = HarnessInspection["tasks"][number];

/**
 * The harness's word for a task's state, and the word the status view shows.
 * A task the scheduler will pick up next is pending work, and only the
 * harness knows that, so the two words are mapped here rather than guessed.
 */
const STATUS_BY_KIND = {
  running: "running",
  ready: "pending",
  waiting: "waiting",
  completing: "completing",
  blocked: "blocked",
} as const satisfies Record<InspectedTask["state"]["kind"], TaskView["status"]>;

/**
 * A task's checkpoint is its own state, and the step it is on is that
 * state's `phase` — the field every task definition keeps. The harness erases
 * the checkpoint's type when it reports a task, so the phase is read out of
 * the record and taken only when it is really a string.
 */
const PhaseSchema = Schema.Struct({ phase: Schema.String });
const isPhase = Schema.is(PhaseSchema);

const phaseOf = (task: InspectedTask): string | undefined => {
  const checkpoint = task.record.state.checkpoint;
  return isPhase(checkpoint) ? checkpoint.phase : undefined;
};

const viewOf = (task: InspectedTask): TaskView => {
  const record = task.record;
  const state = task.state;
  return {
    id: String(record.id),
    kind: record.kind,
    session: String(record.conversationId),
    status: STATUS_BY_KIND[state.kind],
    phase: phaseOf(task),
    owner: record.owner === undefined ? undefined : String(record.owner),
    background: record.background === true,
    reason: state.kind === "blocked" ? state.reason : undefined,
  };
};

/** The harness's live work, as the status view reports it. Pure. */
export const projectTasks = (inspection: HarnessInspection): readonly TaskView[] =>
  [...inspection.tasks]
    .sort((a, b) => a.record.id - b.record.id)
    .map(viewOf);
