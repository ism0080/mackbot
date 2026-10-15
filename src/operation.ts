/**
 * operation — how mackbot names one unit of submitted work.
 *
 * The origin of a submission lives in its operation id prefix, so the origin is
 * never stored or threaded beside the id. `originOf` reads it back, and the
 * builders below are the only place a prefix is written.
 *
 * A prefix is reserved per origin, so a caller-supplied id is namespaced before
 * it reaches a bot. That stops a client from claiming a `cron:` or `delegate:`
 * id and colliding with work it does not own. Namespacing is idempotent, so a
 * caller can echo back an id the fleet returned and get the same operation
 * instead of a second one.
 */

const HTTP_PREFIX = "http:";
const CRON_PREFIX = "cron:";
const DELEGATE_PREFIX = "delegate:";

/** Where a submission came from. */
export type OperationOrigin = "http" | "cron" | "delegate";

/** Read the origin back out of an operation id. */
export const originOf = (operationId: string): OperationOrigin => {
  if (operationId.startsWith(CRON_PREFIX)) return "cron";
  if (operationId.startsWith(DELEGATE_PREFIX)) return "delegate";
  // Only the HTTP route ever accepted an id without a prefix, so every
  // unprefixed id is a client-supplied one from that route.
  return "http";
};

export const httpOperationId = (supplied: string | undefined): string => {
  if (supplied === undefined) return `${HTTP_PREFIX}${crypto.randomUUID()}`;
  return supplied.startsWith(HTTP_PREFIX) ? supplied : `${HTTP_PREFIX}${supplied}`;
};

/**
 * `scheduledTime` makes the id stable across the retries one scheduled hour can
 * deliver.
 */
export const cronOperationId = (botId: string, scheduledTime: number): string =>
  `${CRON_PREFIX}${botId}:${scheduledTime}`;

export const delegateOperationId = (
  sourceBotId: string,
  supplied: string | undefined,
): string => {
  if (supplied === undefined) return `${DELEGATE_PREFIX}${sourceBotId}:${crypto.randomUUID()}`;
  // Honoring an id the tool already returned is what makes a timed-out
  // delegation safe to retry. Namespacing it again would run the task twice.
  return supplied.startsWith(DELEGATE_PREFIX)
    ? supplied
    : `${DELEGATE_PREFIX}${sourceBotId}:${supplied}`;
};
