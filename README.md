# mackbot

A self-hosted fleet of durable AI teammate bots on Cloudflare Workers, with all
real tooling routed through one Executor v2 MCP endpoint.

- **Vision, architecture, and roadmap:** [`plan.md`](./plan.md)
- **Outstanding feature work:** [`features.md`](./features.md)
- **Agent/contributor guidance:** [`AGENTS.md`](./AGENTS.md)

## Layout

- `alchemy.run.ts` — Worker + `Bot` Durable Object binding, `AI` binding, crons, secrets.
- `bots.json` — the bot registry (model, thinking level, system prompt, delegates, budgets).
- `src/` — the front-door Worker, the `Bot` Durable Object, the Executor bridge, and the seams
  (delegation, audit).
- `tests/` — smoke tests plus a runner.

## Development

```sh
bun install

bun run typecheck   # tsc --noEmit
bun run lint        # oxlint (core profile + vendored forge plugin)
bun run format      # oxfmt
bun run test        # every tests/*.smoke.mjs in its own process
bun run tools:oxlint # build + test the vendored lint plugin
```

The `executor-mcp` smoke test skips cleanly when `EXECUTOR_URL` / `EXECUTOR_TOKEN`
are not set; see [`.env.example`](./.env.example) for the required secrets.

## HTTP surface

Both routes require `Authorization: Bearer <CHAT_BEARER_TOKEN>`. The scheme name
is case-insensitive.

- `POST /chat/:bot` — submit text to a bot. Returns the answer, or `202` with an
  `operationId` when the wait times out or `wait=false` (resubmit the same
  `operationId` to keep waiting; admission is at-most-once).
- `GET /status` — per-bot model, busy state, pending operations with their origin
  (`http`, `cron`, or `delegate`), and usage.

## Deploy

```sh
bun alchemy deploy
```

Cloudflare credentials live in Alchemy profiles (`~/.alchemy/profiles.json`); do
not export `CLOUDFLARE_API_TOKEN`.
