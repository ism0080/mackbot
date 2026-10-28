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

Alchemy resolves the Website's `rootDir`, and then `main` inside it, against the
process's working directory (the API package, because `bun run deploy` filters
to it) — which is why `main` is spelled from the browser app,
`../api/src/index.ts`. The entry's nearest `package.json` has to stay the API's,
because that manifest declares the Worker's dependencies. `bun run
check:deploy-shape` asserts those invariants; keep the Vite root and the deploy
entry at the paths it names.

`apps/api/.env` does not exist: the secrets file stays at the repo root, and the
API's deploy script passes it to Alchemy with `--env-file ../../.env`.

## Dev

`bun run dev` goes through `apps/api/dev.mjs`, which spawns the `alchemy` CLI on
Node with `npm_execpath` cleared. Two things make the obvious path fail:
`alchemy`'s `bin/cli.js` hands itself off to Bun whenever `npm_execpath` names
bun, and under Bun the Website resource spawns its Vite dev child with
`bin/register-dev-mode.js`, a file `alchemy` 2.0.0-beta.84 does not publish. On
Node the CLI runs its compiled `lib/` and the published `bin/register-oxc.js`
loader. Delete the launcher once a release ships that file.

The dev loop is one origin: the Worker in workerd with its real bindings and
Durable Objects, and the Foldkit app on Vite's dev server in front of it. The
browser app authenticates with a cookie and sends `Origin`/`X-Mackbot-CSRF`, so
serving it from a separate port would break the routes it talks to.

## Installs on Windows

Bun keeps its install cache on the system drive. When the checkout lives on
another volume, Bun cannot hardlink out of that cache and copies files instead,
which fails on paths past Windows' 260-character limit — and
`@alchemy.run/cloudflare-runtime` ships `src/rolldown/test/fixtures` deep enough
to reach it. If `bun install` fails with `failed to link package:
@alchemy.run/cloudflare-runtime`, point the cache at the checkout's own volume:
`bun install --cache-dir=D:\bun-cache`.
