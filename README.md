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
  - `tests/` — the HTTP integration suite, plus unit tests for the Worker's
    request, session, operation and registry seams.
- `apps/web/` — `@mackbot/web`, the Foldkit browser app, with its Story and
  Scene tests in `tests/`.
- `packages/contract/` — `@mackbot/contract`, the wire vocabulary the Worker and
  the web app share, with its unit tests in `tests/`.
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
bun run dev         # Worker + web app locally (see Dev)
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

Tests are split by boundary:

- **`packages/contract/tests/`** — Vitest unit tests of the wire vocabulary:
  schemas reject the shapes a route must not accept, paging walks a transcript
  without repeating or skipping an id, and the projections map pi's records to
  the views the browser renders.
- **`apps/web/tests/`** — Foldkit [Story and Scene](https://foldkit.dev/testing)
  tests. Story drives `update` directly and asserts the Model and the Commands
  it returns; Scene drives the rendered view through real interactions and
  assertions. Neither runs a browser or executes a Command's Effect.
- **`apps/api/tests/`** — Vitest unit tests for the pure seams, and an
  [Alchemy](https://alchemy.run/testing) integration suite that deploys the
  real Stack once in local-dev mode (`Test.make({ dev: true })`), drives the
  live Worker URL over HTTP, and tears it down. It needs no Cloudflare
  credentials; the repo-root `.env` supplies the Worker's secrets, which
  `tests/setup.ts` loads into `process.env`.

```sh
bun run test              # every workspace member's suite
bun run --filter '@mackbot/api' test   # the integration suite on its own
NO_DESTROY=1 bun run --filter '@mackbot/api' test  # keep the local stack warm
```

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

`apps/web/` is the first-party channel, built and served by the same Worker:
a home screen that groups the fleet into blocked, running, parked and recent
work plus a persistent chats list that keeps every bot's thread reachable once
it goes idle, per-bot transcripts with backward paging, a composer that starts
new work, approval cards with allow and deny, Stop and retry controls, and the
roster editor. It polls `/status`, reads `/bots`, and follows `/events` for each
bot with a run in flight.

Navigation is URL-backed (home, `/new` for the bot picker, `/chat/:bot` for a
transcript, `/bots` for the roster); the Worker's asset binding serves
`index.html` for any other path, so a deep link or a reload lands on the same
screen. The composer posts to `POST /chat/:bot` with `wait=0`, then follows the
run through `/events` plus a short transcript poll while work is in flight.
Tool results appear as collapsed rows — expanded by default only when the tool
failed — rather than as raw JSON in the conversation.

The layout is mobile-first but not device-shaped: the app fills any window, and
one centred reading column keeps a desktop from stretching the triage rows.

## Deploy

```sh
bun run deploy   # build the web app, then deploy it and the Worker
```

`bun run deploy` filters to `@mackbot/api`, where `alchemy.run.ts` declares the
Worker as a `Cloudflare.Website.Foldkit`. That resource runs the Vite build for
`apps/web` as part of the deploy — content-hashed, and skipped when neither the
browser app, the Worker, nor the contract changed — so `apps/web/dist` is never
uploaded stale. The secrets file stays at the repo root: the API's deploy script
passes `--env-file ../../.env`.

`bun run dev` runs the same pair locally: the Worker in workerd with its real
bindings and Durable Objects, and the Foldkit app on Vite's dev server in front
of it. One origin, so the browser app's cookie and CSRF checks behave as they do
in production.

Cloudflare credentials live in Alchemy profiles (`~/.alchemy/profiles.json`); do
not export `CLOUDFLARE_API_TOKEN`.
