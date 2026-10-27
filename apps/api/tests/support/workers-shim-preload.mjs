/**
 * Preload that aliases the `cloudflare:workers` builtin to the local shim.
 *
 * Bun cannot resolve `cloudflare:workers` outside workerd, and the specifier is
 * not a legal directory name on Windows, so a `NODE_PATH` shim is not portable.
 * `mock.module` from a `bun --preload` script resolves the specifier for every
 * import in the process instead.
 */
import { mock } from "bun:test";

const workers = await import("../shims/workers.mjs");

mock.module("cloudflare:workers", () => workers);
