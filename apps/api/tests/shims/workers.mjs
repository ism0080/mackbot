/**
 * The `cloudflare:workers` builtin, as much as Bun needs to load the Worker.
 *
 * Bun cannot resolve `cloudflare:workers` outside workerd. Tests that exercise
 * the real Lifecycle or the Worker's front door re-exec under
 * `support/workers-shim.mjs`, whose preload mocks the specifier to this module.
 *
 * `DurableObject` exists only so the `Bot` class can be defined and its HTTP
 * front door driven with a fake binding; the tests never instantiate it.
 */
export class DurableObject {}

export default { DurableObject };
