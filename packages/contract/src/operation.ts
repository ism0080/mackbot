/**
 * operation — the origin vocabulary of a submitted unit of work.
 *
 * The origin of a submission lives in its operation id prefix, so the origin is
 * never stored or threaded beside the id. `originOf` reads it back. The
 * browser sees the origin on a view, so the prefixes and the reader belong to
 * the wire contract.
 *
 * The Worker owns the writers — the functions that mint an id for a new
 * submission. They read the prefixes below, so the format is defined once.
 */

/**
 * The prefix reserved per origin. A caller-supplied id is namespaced before it
 * reaches a bot, so a client cannot claim a `cron:` or `delegate:` id and
 * collide with work it does not own.
 */
export const OPERATION_PREFIXES = {
  http: "http:",
  cron: "cron:",
  delegate: "delegate:",
} as const;

/** Where a submission came from. */
export type OperationOrigin = keyof typeof OPERATION_PREFIXES;

/**
 * The origin names the wire carries, one per prefix. The prefix map above is
 * the source of truth for both the names and the origins, so a new origin
 * cannot be added to one and forgotten in the other.
 */
export const OPERATION_ORIGINS = {
  http: "http",
  cron: "cron",
  delegate: "delegate",
} as const satisfies Record<OperationOrigin, OperationOrigin>;

/** Read the origin back out of an operation id. */
export const originOf = (operationId: string): OperationOrigin => {
  if (operationId.startsWith(OPERATION_PREFIXES.cron)) return "cron";
  if (operationId.startsWith(OPERATION_PREFIXES.delegate)) return "delegate";
  // Only the HTTP route ever accepted an id without a prefix, so every
  // unprefixed id is a client-supplied one from that route.
  return "http";
};
