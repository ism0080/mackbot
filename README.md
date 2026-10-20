# mackbot

A self-hosted fleet of durable AI teammate bots on Cloudflare Workers, with all
real tooling routed through one Executor v2 MCP endpoint.

- **Vision, architecture, and roadmap:** [`plan.md`](./plan.md)
- **Outstanding feature work:** [`features.md`](./features.md)
- **Agent/contributor guidance:** [`AGENTS.md`](./AGENTS.md)

## Layout

- `alchemy.run.ts` — Worker + `Bot` Durable Object binding, `AI` binding, crons, secrets.
- `bots.json` — the bot registry (model, thinking level, system prompt, delegates).
- `src/` — the front-door Worker, the `Bot` Durable Object, the Executor bridge, and the seams
  (delegation, audit).
- `tests/` — smoke tests plus a runner.

## Development

```sh
bun install

bun run typecheck   # tsc --noEmit
bun run lint        # oxlint (core profile + vendored forge plugin)
bun run lint:css    # stylelint — the good-css rules over every stylesheet under web/src
bun run format      # oxfmt
bun run test        # every tests/*.smoke.mjs in its own process
bun run test:css    # prove each good-css rule still fires (web/stylelint/fixtures)
bun run tools:oxlint # build + test the vendored lint plugin
```

There is no CI workflow: run the checks above locally before pushing. `lint:css`
enforces the [good-css](https://good-css.com) rules that a stylesheet can be
checked for — logical properties, OKLCH colours, focus, hover, press, reduced
motion and `overflow: clip` — with the rules core stylelint cannot express
(anything that depends on the surrounding `@media`) in
[`web/stylelint/`](./web/stylelint/).

The `executor-mcp` smoke test skips cleanly when `EXECUTOR_URL` / `EXECUTOR_TOKEN`
are not set; see [`.env.example`](./.env.example) for the required secrets.

## HTTP surface

Every route requires `Authorization: Bearer <CHAT_BEARER_TOKEN>`. The scheme name
is case-insensitive.

- `POST /chat/:bot` — submit text to a bot. Returns the answer, or `202` with an
  `operationId` when the wait times out or `wait=false` (resubmit the same
  `operationId` to keep waiting; admission is at-most-once).
- `GET /status` — one `BotView` per bot: model, thinking level, busy state,
  pending operations with their origin (`http`, `cron`, or `delegate`), pending
  approvals, the run in flight, and usage. It also reports the failures the
  harness reported and the work it still has live, so a bot that is stuck says
  why. A bot whose status fails lands in the response's `errors` map rather
  than failing the whole call.
- `GET /transcript/:bot?thread=&before=&limit=` — one page of a session's
  transcript, newest first, paged backwards by entry id. `limit` defaults to 50
  and clamps to 200. `nextBefore` appears only when an older page exists.
- `GET /events/:bot?stream=&from=` — Server-Sent Events for one run, served
  through the SDK's resumable writer, so `Last-Event-ID` and `?from=` resume
  where a client left off. The bridge that feeds a stream per run is not wired
  yet.
- `POST /abort/:bot` — stop a bot's current work. The body is optional;
  `{"session": "<id>"}` names the conversation to stop, and an empty body stops
  the bot's root conversation. The answer is `{ bot, session, aborted }`, where
  `aborted` is false when there was nothing running to stop.
- `POST /retry/:bot` — run a parked task again. The body is
  `{"taskId": "<id>"}`, naming a task the harness parked after too many
  restarts. The answer is `{ bot, taskId, retried }`, where `retried` is false
  when nothing was parked under that id.

The Worker and the web app share one vocabulary in
[`src/web-contract.ts`](./src/web-contract.ts). Every route decodes its input and
its output against a Schema there, so the two cannot drift apart.

## Deploy

```sh
bun alchemy deploy
```

Cloudflare credentials live in Alchemy profiles (`~/.alchemy/profiles.json`); do
not export `CLOUDFLARE_API_TOKEN`.
