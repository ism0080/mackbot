/**
 * Bun cannot resolve the `cloudflare:workers` builtin that `agents/lifecycle`
 * imports for its side effects. Tests that exercise the real Lifecycle put this
 * directory on NODE_PATH, which Bun consults for bare specifiers, so the import
 * resolves to an empty module instead of the Workers runtime.
 */
export {};
