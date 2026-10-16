/**
 * Bun cannot resolve the `cloudflare:workers` builtin that `agents/lifecycle`
 * and `src/index.ts` import. Tests that exercise the real Lifecycle or the
 * Worker's front door put this directory on NODE_PATH, which Bun consults for
 * bare specifiers, so the import resolves here.
 *
 * `DurableObject` exists only so the `Bot` class can be defined and its HTTP
 * front door driven with a fake binding; the tests never instantiate it.
 */
export class DurableObject {}

export default { DurableObject };
