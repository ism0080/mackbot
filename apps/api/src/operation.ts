/**
 * operation — how mackbot names one unit of submitted work.
 *
 * The origin of a submission lives in its operation id prefix, so the origin is
 * never stored or threaded beside the id. The prefix format and the reader that
 * decodes it live in the wire contract, because the browser reads origins off
 * the views the Worker sends; the builders below are the only place a prefix
 * is written.
 *
 * A prefix is reserved per origin, so a caller-supplied id is namespaced before
 * it reaches a bot. That stops a client from claiming a `cron:` or `delegate:`
 * id and colliding with work it does not own. Namespacing is idempotent, so a
 * caller can echo back an id the fleet returned and get the same operation
 * instead of a second one.
 */

import { OPERATION_PREFIXES } from "@mackbot/contract";

const HTTP_PREFIX = OPERATION_PREFIXES.http;
const CRON_PREFIX = OPERATION_PREFIXES.cron;
const DELEGATE_PREFIX = OPERATION_PREFIXES.delegate;

export const httpOperationId = (supplied: string | undefined): string => {
  if (supplied === undefined) return `${HTTP_PREFIX}${crypto.randomUUID()}`;
  return supplied.startsWith(HTTP_PREFIX) ? supplied : `${HTTP_PREFIX}${supplied}`;
};

/**
 * The steering submission a human's decision admits. Prefixed `http:` because
 * the decision arrived on an HTTP route, and derived from the approval so a
 * replay of the same decision names the same operation instead of admitting a
 * second steer.
 */
export const approvalOperationId = (approvalId: string): string =>
  `${HTTP_PREFIX}approval:${approvalId}`;

/**
 * `scheduledTime` makes the id stable across the retries one scheduled hour can
 * deliver.
 */
export const cronOperationId = (botId: string, scheduledTime: number): string =>
  `${CRON_PREFIX}${botId}:${scheduledTime}`;

/**
 * The audit id of a stop. A stop admits no submission, so it has no operation
 * of its own; the id names the session that was stopped instead.
 */
export const abortOperationId = (session: string): string => `abort:${session}`;

/**
 * The operation one delegated tool call submits under.
 *
 * The id comes from the call's durable task, not from the model, so a replay of
 * the call after an eviction derives the same id and the target's idempotent
 * submission joins the first attempt instead of submitting the work twice.
 * Nothing the model says can move it.
 */
export const delegateTaskOperationId = (sourceBotId: string, taskId: string): string =>
  `${DELEGATE_PREFIX}${sourceBotId}:task:${taskId}`;

/**
 * An explicit caller override for that id, namespaced into its own `caller:`
 * segment so a supplied id can never look like the target's own `http:`,
 * `cron:`, or `delegate:` work. Callers normally omit it; the task-derived id
 * above is the retry-safe one.
 */
export const delegateCallerOperationId = (sourceBotId: string, supplied: string): string =>
  `${DELEGATE_PREFIX}${sourceBotId}:caller:${supplied}`;

/**
 * The request id a delegation's answer arrives under in the delegating
 * conversation. It is derived from the call rather than from the reporter task,
 * so a reporter that restarts — or a second reporter for the same call — finds
 * the first report instead of posting another.
 */
export const delegateReportRequestId = (sourceBotId: string, taskId: string): string =>
  `delegate-report:${sourceBotId}:task:${taskId}`;

/**
 * The earlier, model-supplied delegation id. Kept because other callers may
 * still name a delegation explicitly; the tool now derives its id from the
 * call's task (see {@link delegateTaskOperationId}).
 */
export const delegateOperationId = (sourceBotId: string, supplied: string | undefined): string => {
  if (supplied === undefined) return `${DELEGATE_PREFIX}${sourceBotId}:${crypto.randomUUID()}`;
  // Honoring an id the tool already returned is what makes a timed-out
  // delegation safe to retry. Namespacing it again would run the task twice.
  return supplied.startsWith(DELEGATE_PREFIX)
    ? supplied
    : `${DELEGATE_PREFIX}${sourceBotId}:${supplied}`;
};
