/**
 * Upper bound on a single blocking wait for a bot operation. It stays under the
 * ~60s harness tool-call timeout (so a `delegate_to_bot` wait settles before the
 * tool is cut off) and well under Cloudflare's ~100s edge request timeout (so a
 * `POST /chat/:bot` long-poll cannot turn into a 524). Used by both the HTTP
 * long-poll and the `delegate_to_bot` tool.
 */
export const LONG_POLL_TIMEOUT_MS = 55_000;
