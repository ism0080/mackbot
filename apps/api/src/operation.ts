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
  // A fresh id must not collide with another client's, so it comes from the
  // CSPRNG: Effect's `Random` is not one, and effect/Crypto ships no WebCrypto layer.
  // oxlint-disable-next-line forge/no-ambient-nondeterminism -- collision-free id
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
 * The audit id of a paused call that has no approval: one the bot was not
 * allowed to record, or a resume nobody vouched for. It names Executor's
 * request id, the only thing such a call has.
 */
export const pausedCallAuditId = (requestId: string): string => `paused:${requestId}`;

/**
 * The bots a delegation passed through before its source, as the `via:`
 * segment of its id. Absent for a delegation that started with a person or a
 * schedule, so the id of a first hand-off is what it always was.
 */
const viaSegment = (upstream: readonly string[]): string =>
  upstream.length === 0 ? "" : `via:${upstream.join(",")}:`;

/**
 * The operation one delegated tool call submits under.
 *
 * The id comes from the call's durable task, not from the model, so a replay of
 * the call after an eviction derives the same id and the target's idempotent
 * submission joins the first attempt instead of submitting the work twice.
 * Nothing the model says can move it. `upstream` is the chain of bots that
 * handed this work along before `sourceBotId`, oldest first: it is fixed for
 * the run the call belongs to, so a replay derives it again unchanged.
 */
export const delegateTaskOperationId = (
  sourceBotId: string,
  taskId: string,
  upstream: readonly string[] = [],
): string => `${DELEGATE_PREFIX}${sourceBotId}:${viaSegment(upstream)}task:${taskId}`;

/**
 * An explicit caller override for that id, namespaced into its own `caller:`
 * segment so a supplied id can never look like the target's own `http:`,
 * `cron:`, or `delegate:` work. Callers normally omit it; the task-derived id
 * above is the retry-safe one.
 */
export const delegateCallerOperationId = (
  sourceBotId: string,
  supplied: string,
  upstream: readonly string[] = [],
): string => `${DELEGATE_PREFIX}${sourceBotId}:${viaSegment(upstream)}caller:${supplied}`;

/**
 * The source bot and the `via:` chain, which come before any caller-supplied
 * text: bot ids are slugs, so neither can contain the `:` that ends them.
 */
const DELEGATION_CHAIN = /^delegate:([a-z0-9][a-z0-9-]*):(?:via:([a-z0-9,-]+):)?(?:task|caller):/u;

/**
 * The bots a delegated operation has passed through, oldest first and ending
 * with the bot that submitted it; empty for an operation no bot delegated.
 * Only the two builders above write the segments this reads.
 */
export const delegationChainOf = (operationId: string): readonly string[] => {
  const match = DELEGATION_CHAIN.exec(operationId);
  if (match === null) return [];
  const via = match[2] === undefined ? [] : match[2].split(",").filter((id) => id !== "");
  return [...via, match[1] ?? ""];
};

/**
 * The request id a delegation's answer arrives under in the delegating
 * conversation. It is derived from the call rather than from the reporter task,
 * so a reporter that restarts — or a second reporter for the same call — finds
 * the first report instead of posting another.
 */
export const delegateReportRequestId = (sourceBotId: string, taskId: string): string =>
  `delegate-report:${sourceBotId}:task:${taskId}`;
