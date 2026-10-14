/**
 * constants — values shared across the front door, the Bot Durable Object, and
 * the delegation bridge.
 */

/**
 * Upper bound on a single blocking wait for a bot operation, kept under
 * Cloudflare's request/tool limits. Used by `POST /chat/:bot` long-polling and
 * by the `delegate_to_bot` tool's wait.
 */
export const LONG_POLL_TIMEOUT_MS = 55_000;
