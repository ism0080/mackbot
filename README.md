# mackbot

A self-hosted fleet of durable AI teammate bots on Cloudflare Workers, with all
real tooling routed through one Executor v2 MCP endpoint.

- **Vision, architecture, and roadmap:** [`plan.md`](./plan.md)
- **Outstanding feature work:** [`features.md`](./features.md)
- **Agent/contributor guidance:** [`AGENTS.md`](./AGENTS.md)

## Layout

This is a bun workspace. `apps/` holds the two deployable/runnable faces, and
the root package is the workspace orchestrator; every other package is a member.

- `apps/api/` — `@mackbot/api`, the Worker app.
  - `alchemy.run.ts` — Worker + `Bot` Durable Object binding, `AI` binding, crons, secrets.
  - `bots.json` — the seed roster (model, thinking level, system prompt, delegates).
  - `src/` — the front-door Worker, the `Bot` Durable Object, the Executor bridge, and the seams
    (delegation, audit).
  - `tests/` — smoke tests plus a runner.
- `apps/web/` — `@mackbot/web`, the Foldkit browser app.
- `packages/contract/` — `@mackbot/contract`, the wire vocabulary the Worker and
  the web app share.
- `tools/oxlint/` — the vendored `@ism0080/oxlint-plugin-forge` lint plugin.

## Development

```sh
bun install

bun run check       # deploy shape, typecheck, lint and test
bun run typecheck   # tsc --noEmit, for every workspace member
bun run lint        # oxlint (core profile + vendored forge plugin)
bun run lint:css    # stylelint — the good-css rules over every stylesheet under apps/web/src
bun run format      # oxfmt
bun run test        # every workspace member's tests
bun run test:css    # prove each good-css rule still fires (apps/web/stylelint/fixtures)
bun run tools:oxlint # build + test the vendored lint plugin
bun run deploy      # deploy apps/api (see Deploy)
```

`bun run check` is the gate: it asserts the deploy shape, then typechecks,
lints, and tests every workspace member. It does not include `lint:css` /
`test:css`, so run those too when a stylesheet changes.

There is no CI workflow: run `bun run check` locally before pushing. `lint:css`
enforces the [good-css](https://good-css.com) rules that a stylesheet can be
checked for — logical properties, OKLCH colours, focus, hover, press, reduced
motion and `overflow: clip` — with the rules core stylelint cannot express
(anything that depends on the surrounding `@media`) in
[`apps/web/stylelint/`](./apps/web/stylelint/).

The `executor-mcp` smoke test skips cleanly when `EXECUTOR_URL` / `EXECUTOR_TOKEN`
are not set; see [`.env.example`](./.env.example) for the required secrets.

## HTTP surface

The API takes either `Authorization: Bearer <CHAT_BEARER_TOKEN>` (the scheme
name is case-insensitive) or a session cookie. A browser proves the token once
at `/login` and carries a signed cookie after that; the cookie is derived from
the bearer, so rotating the token invalidates every session. A
cookie-authenticated mutation must also send `Origin: <this origin>` and
`X-Mackbot-CSRF: 1`; a bearer request needs neither. An unauthenticated API call
gets `401` JSON, while an unauthenticated navigation is redirected to `/login`.

- `GET /login` — the token form, a static page with no script. `POST /login`
  with a `token` form field answers `303` to `/` and sets the cookie, or `401`
  with the form again.
- `POST /chat/:bot` — submit text to a bot. Returns the answer, or `202` with an
  `operationId` when the wait times out or `wait=0` (resubmit the same
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
- `GET /events/:bot?thread=&stream=&from=&gen=` — Server-Sent Events for one
  run, named `feed:<session>:<ordinal>` and rotated to a new segment only when
  it reaches the chunk ceiling. `?stream=` names a stream, and `?thread=`
  resolves to that session's newest run. Sequence zero is always a snapshot, so
  a client that lost its place can rebuild; every frame carries its generation,
  so `Last-Event-ID` and `?from=` resume within a generation, and a `gen` the
  stream no longer serves replays from the snapshot instead of skipping the
  head.
- `POST /approvals/:bot/:approvalId` — decide a paused call. The body is
  `{"action": "allow" | "deny"}` with an optional `content` map. The decision is
  recorded durably and steered into the pausing session, and the harness's hook
  lets only a human-decided `executor_resume` through. An approval that is
  already decided, unknown or not resumable answers `409` rather than resuming
  twice.
- `POST /abort/:bot` — stop a bot's current work. The body is optional;
  `{"session": "<id>"}` names the conversation to stop, and an empty body stops
  the bot's root conversation. The answer is `{ bot, session, aborted }`, where
  `aborted` is false when there was nothing running to stop.
- `POST /retry/:bot` — run a parked task again. The body is
  `{"taskId": "<id>"}`, naming a task the harness parked after too many
  restarts. The answer is `{ bot, taskId, retried }`, where `retried` is false
  when nothing was parked under that id.
- `GET /bots` — the roster: one configuration per bot, keyed by bot id.
- `POST /bots` — add a bot. The body is `{"id": "<slug>", "bot": <configuration>}`.
- `PUT /bots/:id` — replace a bot's configuration. The body is
  `{"bot": <configuration>}`.
- `GET /models` — the models the Worker knows, and the thinking levels each one
  supports.

## The bot roster

The roster lives in the `Registry` Durable Object, not in the bundle. The web
app reads it at `GET /bots` and writes to it, so a bot's prompt, model or
brief changes without a redeploy.

`bots.json` is the seed. A registry that has never been seeded takes its bots
from the file; after that the registry is the only truth, and the file is
inert. Deleting a bot is not offered yet, so an empty registry means a fresh
one.

A bot's id is a slug, `^[a-z0-9][a-z0-9-]{0,62}$`: it is the Durable Object's
name, the path segment the routes carry it in, and the key its transcript is
filed under.

A bot's model is one id. A Workers AI model is named by its own `@cf/...`
path; every other model is named by its id in the OpenCode Go catalog. The
catalog crosses the wire at `GET /models` rather than reaching the browser's
module graph, so the Worker stays the one that knows which models exist.

The Worker and the web app share one vocabulary in the
[`@mackbot/contract`](./packages/contract) package. Every route decodes its
input and its output against a Schema there, so the two cannot drift apart.

## The web app

`apps/web/` is the first-party channel, served by the same Worker from
`apps/web/dist`:
a home screen that groups the fleet into blocked, running, parked and recent
work, per-bot transcripts with backward paging, approval cards with allow and
deny, Stop and retry controls, and the roster editor. It polls `/status`, reads
`/bots`, and follows `/events` for each bot with a run in flight.

Navigation is in-app (home, then a bot's transcript); the Worker's asset binding
serves `index.html` for any other path, so a deep link still loads the app. It
cannot originate work yet: there is no composer for `POST /chat/:bot`, so today
the API starts work and the app observes and steers it.

## Deploy

```sh
bun run --filter @mackbot/web build   # refresh apps/web/dist (the Worker's assets)
bun run deploy                        # alchemy deploy, run inside apps/api
```

`bun run deploy` filters to `@mackbot/api`, so Alchemy resolves the Worker entry
and `../web/dist` against that package. The secrets file stays at the repo root:
the API's deploy script passes `--env-file ../../.env`.

Cloudflare credentials live in Alchemy profiles (`~/.alchemy/profiles.json`); do
not export `CLOUDFLARE_API_TOKEN`.
