/**
 * task-retry — the tasks the harness parked, and the ones a human can run again.
 *
 * A bot whose every turn crashes is cut off and restarted by the Durable
 * Object's wake job, and each of those restarts costs an alarm invocation and
 * a model call. The harness counts the restarts and parks the task as blocked
 * with the reason `restart_limit` once `settings.restartLimit` is reached, so
 * the fleet stops paying for a task that cannot make progress;
 * `Harness.retryTask()` is what runs it again.
 *
 * Pure: it reads one inspection and returns the parked tasks among them, so
 * the same harness state always projects to the same list.
 */

import type { HarnessInspection } from "@earendil-works/pi-durable";

import { projectTasks } from "./liveness.ts";
import type { TaskView } from "@mackbot/contract";

/** The harness's own reason for a task it parked instead of running again. */
const PARKED_REASON = "restart_limit";

/**
 * The tasks the harness parked after too many restarts, oldest id first.
 *
 * The projection in `liveness.ts` maps every live task and sorts it by numeric
 * task id, so the parked subset keeps that order and two polls of the same
 * state agree on it.
 */
export const parkedTasks = (inspection: HarnessInspection): readonly TaskView[] =>
  projectTasks(inspection).filter(
    (task) => task.status === "blocked" && task.reason === PARKED_REASON,
  );
