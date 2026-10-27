# mackbot agent guidance

This repository uses Effect v4 for Effect-facing code. Follow
`node_modules/effect/AGENTS.md` and `node_modules/effect/CLAUDE.md` for Effect
patterns: prefer `Effect.gen`, `Effect.fn`, Schema-based validation, services and
layers, and Effect error handling instead of `try/catch`.

## Boundaries

- `apps/api/src/index.ts`, the Cloudflare Agents SDK, Pi Durable, and the MCP SDK
  are promise/callback APIs. Wrap at Effect boundaries with `Effect.runPromise`
  or `Effect.tryPromise` rather than forcing Pi SDK types into pure Effect
  services.
- Do not hand-write `is*` helpers. Use Effect `Predicate`, Schema, or
  `Object.prototype.toString` checks where lint requires it.
- Keep direct HTTP calls behind Effect or the pi-durable model-tools, never raw
  `fetch` in source.
- `packages/contract/` is the wire vocabulary both the Worker and the browser
  read. It must stay free of Workers-only APIs and of the Worker's own modules,
  because the browser bundles it. Put shared vocabulary there rather than
  reaching across a package boundary.

## Layout

`apps/api` is the Worker app and the deploy entry; `apps/web` is the browser
app. `packages/contract/` is the shared vocabulary, and `tools/oxlint/` is the
vendored lint plugin. Every package is a workspace member, so one
`bun install` manages them all and `bun run check` runs every check.

Alchemy resolves `main` and `assets.directory` against the process's working
directory (the API package, because `bun run deploy` filters to it), and the
bundler resolves from the nearest `package.json` above the entry. `bun run
check:deploy-shape` asserts those invariants; keep the deploy entry and the
assets directory at the paths it names.

`apps/api/.env` does not exist: the secrets file stays at the repo root, and the
API's deploy script passes it to Alchemy with `--env-file ../../.env`.
