# mackbot agent guidance

This repository uses Effect v4 for Effect-facing code. Follow
`node_modules/effect/AGENTS.md` and `node_modules/effect/CLAUDE.md` for Effect
patterns: prefer `Effect.gen`, `Effect.fn`, Schema-based validation, services and
layers, and Effect error handling instead of `try/catch`.

## Boundaries

- `src/index.ts`, the Cloudflare Agents SDK, Pi Durable, and the MCP SDK are
  promise/callback APIs. Wrap at Effect boundaries with `Effect.runPromise` or
  `Effect.tryPromise` rather than forcing Pi SDK types into pure Effect services.
- Do not hand-write `is*` helpers. Use Effect `Predicate`, Schema, or
  `Object.prototype.toString` checks where lint requires it.
- Keep direct HTTP calls behind Effect or the pi-durable model-tools, never raw
  `fetch` in source.
