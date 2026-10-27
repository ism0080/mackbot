# mackbot — personal AI teammate fleet

> Modeled on [Grok Bot](https://x.ai/bot) (xAI): AI teammates you give real work to.
> Self-hosted on Cloudflare Workers + Executor v2. Hermes-style always-on durability underneath — Grok Bot-style product on top.

---

## Vision

Grok Bot's pitch: bots you message like teammates — they sign into your tools, keep context on how you work, run 24/7 in parallel, come back when your approval is needed, and get smarter over time.

mackbot is the self-hosted version of that: a fleet of durable agent bots, each with a job, an identity, a model, and a system prompt — reachable via HTTP and the first-party web app (Telegram as an optional phone channel, added last) — with all real tooling routed through one Executor MCP endpoint.

### Grok Bot → mackbot mapping

| Grok Bot concept                                   | mackbot v1                                                                                                                                                                                                                                      | Later phase                                                                                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Bots with jobs (Sales Outbound, Chief of Staff, …) | One bot per job in the durable roster (`bots.json` seeds it), with its own model and system prompt; Telegram identity optional                                                                                                                  | Reusable bot presets (own "marketplace")                                                                                                |
| Message bots like teammates                        | HTTP API (`POST /chat/:bot`) and the first-party web app (per-run SSE, approvals, stop/retry, roster editing)                                                                                                                                   | A composer in the app, Telegram DMs (added last), more channels (Discord, …)                                                            |
| 24/7, survives everything                          | Pi Durable in SQLite-backed Durable Objects; wake-up alarms resume mid-run after eviction/crash/deploy                                                                                                                                          | —                                                                                                                                       |
| "Own computer" / shared cloud computer             | Executor v2 apps hold all real tools and accounts (bots stay thin)                                                                                                                                                                              | Shared workspace per user: sandbox phase — Daytona / Cloudflare Containers / homelab remote `ExecutionEnv`                              |
| Routines on a schedule                             | Cron Triggers → per-bot briefs (stable `operationId` = at-most-once)                                                                                                                                                                            | "Show me once" workflow capture → saved routine                                                                                         |
| Memory, smarter over time                          | Per-conversation typed docs + automatic compaction                                                                                                                                                                                              | Cut 2026-10-16; see Cross-bot memory below                                                                                              |
| Approvals / Auto Review                            | Executor approvals guard server-side; `model` elicitation mode — a paused call returns a `requestId`, the bot puts the question to you in the channel it is talking to you on, and `resume` collects the answer; unsafe tools never auto-replay | Channel approve/deny buttons, and remembered approvals. `browser` mode also exists, but its approval URL carries the connection token   |
| Bots in one thread passing work                    | Built-in `delegate_to_bot` pi tool: any bot submit()s a task to another bot's DO and long-polls (55s) or returns a receipt; unsafe replay; approval links relayed in the answer. No per-bot gating (any→any) in v1                              | Bot-to-bot delegation hardening: `delegatesTo` allowlists in bots.json, fire-and-poll / async callbacks, and richer multi-bot threading |

Infrastructure pattern is the Hermes one (always-on durable agent harness). Product shape is Grok Bot: a fleet of teammates with jobs, not one general assistant.

---

## Architecture

```
POST /chat/:bot  ·  web app (/status, /events, /approvals, /bots, …)  ·  cron (hourly)  ·  Telegram (optional, last)
                    │
           Front-door Worker  (single, plain fetch/scheduled handlers)
                    │  validate bearer or session cookie → botId from the Registry;  env.Bot.getByName(botId)
     ┌──────────────┼──────────────┐
     ▼              ▼              ▼
 Bot:hermes     Bot:scribe      Bot:…        one DO instance per bot
 PiHarness      PiHarness       …           SQLite state, wake-up alarms
 opencode-go    opencode-go     …           per-bot model + system prompt (pi.agent)
     └──────────────┼──────────────┘
                    ▼  MCP meta-tools (streamable HTTP · org URL · model approvals · PAT bearer)
              Executor v2  (public endpoint; apps hold all real tools & accounts)
```

## Locked decisions

| Decision                  | Choice                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime / durability      | Pi Durable via Cloudflare Agents SDK `PiHarness` (beta) in SQLite-backed Durable Objects                                                                                                                                                                                                                                                                                                     |
| Deploy tooling            | **Alchemy v2** (async Worker + `Cloudflare.DurableObject` binding — auto SQLite class migrations; no wrangler)                                                                                                                                                                                                                                                                               |
| Bot topology              | **One DO instance per bot** (`getByName(botId)`), root session each                                                                                                                                                                                                                                                                                                                          |
| Per-bot config            | **The `Registry` Durable Object** holds the roster (model, thinking level, system prompt, delegates); `bots.json` seeds a fresh registry and is inert afterwards; the web app writes to it; applied per session, idempotently, via `pi()` → `root.configure()`                                                                                                                               |
| Models                    | **OpenCode Go** (`opencode-go` provider, `OPENCODE_API_KEY`); cheap tier: Workers AI (`@cf/...`) or free catalog models (`longcat-2.5-preview-free`, `step-5-preview-free`)                                                                                                                                                                                                                  |
| Tooling                   | **Executor v2 meta-tools only** — bots never talk to apps directly                                                                                                                                                                                                                                                                                                                           |
| Channels                  | **HTTP API and the first-party web app** (`POST /chat/:bot` + bearer or session cookie); per-run SSE events feed the app; **Telegram last, optional**                                                                                                                                                                                                                                        |
| Idempotency               | `operationId` carries its origin in a prefix, built only in `apps/api/src/operation.ts` - `http:<uuid-or-client-id>`, `cron:<botId>:<scheduledTime>`, `delegate:<source>:<id>`; at-most-once admission across retries/evictions, and prefixing is idempotent so an id the fleet returned rejoins the same operation                                                                                   |
| Ingress auth              | Bearer secret on the `POST /chat/:bot` route, or a browser session cookie issued by `/login` (signed from the bearer; cookie mutations need a matching `Origin` and `X-Mackbot-CSRF: 1`) — anyone who finds the URL could otherwise drive the bots and their Executor spend; when Telegram lands: per-bot webhook `secret_token`, validate `X-Telegram-Bot-Api-Secret-Token` on every update |
| Cost posture              | Free tier first: `progress: { partialIntervalMs: 1000, outputIntervalMs: 1000 }` (~10x fewer SQLite row writes); Workers Paid ($5) only if limits trip                                                                                                                                                                                                                                       |
| Sandboxing (Daytona etc.) | **Deferred** — no code seam today; the route stays an `ExecutionEnv` / Executor app; revisit when a bot needs to build/run things (Grok Bot's "own computer" phase)                                                                                                                                                                                                                          |
| Executor hosting          | Free tier (solo, $0) or self-host — both work; `EXECUTOR_URL` = org MCP URL (no query, so `model` elicitation), `EXECUTOR_TOKEN` = org-scoped PAT                                                                                                                                                                                                                                            |

## Project layout

```
mackbot/
├── package.json         # the workspace root (lint/format/test scripts)
├── oxlint.config.ts     # lint config — core profile on everything, effect profile on apps/api/alchemy.run.ts only
├── .env.example         # documented secret names (copy to .env; never commit .env)
├── apps/
│   ├── api/             # @mackbot/api — the Worker app and the deploy entry
│   │   ├── alchemy.run.ts  # Worker, Bot + Registry DO bindings, AI binding, crons, secrets (Config.Redacted)
│   │   ├── bots.json       # the seed roster (the durable roster lives in the Registry DO)
│   │   ├── tests/          # smoke tests + runner (routes, approvals, streams, registry, delegation, executor-mcp, …)
│   │   └── src/
│   │       ├── index.ts         # Bot class (PiHarness + ensureBot) + front door fetch + scheduled
│   │       ├── bots.ts          # the registry's rules (model, thinking level, roster) + modelRef resolution
│   │       ├── registry.ts      # the Registry DO: the durable roster and its writes
│   │       ├── feed.ts          # per-run SSE: durable chunk log, generations, resume
│   │       ├── approvals.ts     # durable paused calls and the path from a decision to a resume
│   │       ├── runs.ts          # run windows: which submission produced which entries
│   │       ├── session.ts       # the login cookie and the CSRF proof
│   │       ├── executor-mcp.ts  # Executor v2 bridge (6 meta-tools, MCP TS SDK streamable HTTP)
│   │       ├── bot-delegation.ts# delegate_to_bot pi tool (guards + long-poll)
│   │       ├── chat-request.ts  # front-door request contract (bearer, byte cap, body schema)
│   │       ├── operation.ts     # operation id builders (the prefixes and the origin reader live in the contract)
│   │       ├── audit-log.ts     # append-only SQLite audit seam
│   │       ├── runtime.ts       # ManagedRuntime bridge for Pi/Cloudflare callbacks
│   │       └── services/        # BotRegistryService, DelegationPolicy
│   │           ├── bot-registry.ts
│   │           └── delegation.ts
│   └── web/             # @mackbot/web — the Foldkit browser app, built into apps/web/dist and served by the Worker
├── tools/oxlint/        # vendored @ism0080/oxlint-plugin-forge (a workspace member, builds + tests green)
└── packages/contract/   # @mackbot/contract — the wire vocabulary the Worker and the web app share
```

Dependencies (all pinned): `alchemy`, `effect`, `agents`, `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, `@earendil-works/chord`, `@modelcontextprotocol/sdk`; for the web app, `foldkit` and `vite`. No hono/grammy — plain `fetch` handlers.

Lint tooling (vendored from the forge repo, already in place): `tools/oxlint/` holds the `@ism0080/oxlint-plugin-forge` rule set (anti-slop / effect / react / xstate profiles) and is a workspace member, so one `bun install` manages it. Root `oxlint.config.ts` enables the core profile on everything and the effect profile on `apps/api/alchemy.run.ts` only (`apps/api/src/` wraps the Pi/Cloudflare promise+callback SDKs at its boundaries, where Effect-idiom rules like `no-direct-fetch`/`no-try-catch` would fight deliberate boundary code); the plugin's own source is ignored by the root config and verifies itself via `bun run tools:oxlint` (tsc build + vitest + smoke). The react/xstate profiles stay unused: the web app is vanilla DOM driven by Foldkit and lints under its own config. Scripts: `lint` / `format` (oxfmt) / `tools:oxlint`.

The wire vocabulary the Worker and the web app share lives in `packages/contract/` (`@mackbot/contract`), a source-only workspace package: no build step, and the browser and the Worker read the same Schemas. It owns the wire enums (operation origins, thinking levels) and the paging rule; the Worker owns the id builders, and the model catalog lives in the contract's `catalog.ts` because the wire's thinking-level union derives from it (the browser imports the union, never the catalog).

`bots.json` sketch:

```jsonc
{
  "hermes": {
    "model": { "provider": "opencode-go", "modelId": "deepseek-v4-pro" },
    // thinkingLevel must be one of the model's variants — they differ per model
    // (deepseek-v4-pro supports only "high"/"max"; glm-5.3 has "low"/"high"/"max")
    "thinkingLevel": "high",
    "systemPrompt": "You are … (job description + executor protocol) …",
    // Custom UI is the only channel; no channel-specific credential fields.
  },
}
```

Model may also be a `"@cf/..."` string (Workers AI via the `AI` binding). The opencode-go catalog (22 models as of 2026-10) includes two **free** ones — `longcat-2.5-preview-free` and `step-5-preview-free`, $0 in/out — a natural cheap tier for low-stakes bots.

## Executor v2 bridge

Six meta-tools, all exposed as pi tools (context cost stays fixed as apps grow — the endpoint's tool list never grows with apps):

| pi tool             | Wraps               | Replay     | Use                                                                                       |
| ------------------- | ------------------- | ---------- | ----------------------------------------------------------------------------------------- |
| `executor_search`   | `executor.search`   | safe       | Discover tools by words/namespace                                                         |
| `executor_describe` | `executor.describe` | safe       | Full signatures before calling                                                            |
| `executor_call`     | `executor.call`     | **unsafe** | One/few direct `{path, input}` calls (array runs concurrently)                            |
| `executor_execute`  | `executor.execute`  | **unsafe** | JS program when one call feeds another or results need filtering                          |
| `executor_skills`   | `executor.skills`   | safe       | Read an app's instructions before first use                                               |
| `executor_resume`   | `executor.resume`   | **unsafe** | Answer a paused approval/input request (unsafe: it's the call that authorizes the effect) |

`resume` is not optional: in `model` and `browser` elicitation modes, any approval-gated call pauses and returns a pending `requestId` — without `resume` the bridge stalls forever on the first such call. (`native` mode has no `resume` but needs a form-elicitation MCP client — not the pi path.)

**Elicitation mode: `model` for v1.** With a PAT the mode is chosen by the URL query, and leaving the query off selects `model`. A paused call then returns a `requestId` and nothing else, so the bot puts the question to you in the channel it is already talking to you on, and `resume({ requestId })` collects the answer. `?elicitation_mode=browser` also works, and returns an `approvalUrl`, but that URL carries the connection as `grantId=pat:{"token":…}`, so a browser-mode bot relays its own Executor credential to the model provider on every approval. Measured against Executor on 2026-10-15, and the reason model mode is the default here. `native` mode has no `resume` and needs a form-elicitation client, so it is not the pi path.

The extension's prompt section teaches the protocol: search → describe → call for direct work, execute for composition, skills before first use of an app — and that `search` returns exact profile paths for account-backed apps (`tools.<app>.profiles["<profile-id>"]...`). After an eviction, unsafe calls surface as "interrupted" and the model decides — never auto-replayed. Executor-side restarts are the same deal: resuming a program after a server restart is not supported, and a lost session must not be re-run automatically.

**Auth**: org MCP URL — hosted `https://mcp.executor.sh/org/<org-id-or-slug>/mcp`, self-host `<origin>/mcp?...` — with an **org-scoped PAT** as bearer (`EXECUTOR_TOKEN`). Caveats: a full-account PAT on the bare `/mcp` URL needs an `X-Executor-Organization` header; PATs have no permission/tool-selection settings of their own, so org scope is the practical ceiling on hosted. Scoped connections (`/mcp?connection=<id>` — per-app profiles, all/read-only/picked tools) are the documented way to limit an agent, but they follow OAuth grants and "personal access tokens … are not limited by a connection"; verify a PAT at a connection URL actually scopes before relying on it, or accept org scope (self-host controls exposure at the app level instead).

**Accounts & profiles** (human-side setup): connect each account once per provider via the dashboard or a connection link — an agent must never take a secret in chat or read a token out of files. Each app's profile selects which account its tools use; profile IDs appear in tool paths. Future Grok-Bot-style flow: `accountConnect.issue` hands the human a connection link (30-min expiry, poll `accountConnections.get` until `Completed`).

Implementation: `@modelcontextprotocol/sdk` `StreamableHTTPClientTransport` (works on Workers with `nodejs_compat`), per-call connection (eviction-proof) or cached on the DO instance; bearer token from `EXECUTOR_TOKEN`. Set the client's tool-call timeout well above the common 60s default — `execute` programs run up to 5 minutes server-side, and time waiting for approval doesn't count against the server limit but does tick the client clock. (Fallback if six meta-tools ever feel heavy: pi-durable ships `createToolSearchExtension()` for large deferred tool sets "such as an MCP server's" — but the meta-tool bridge keeps context cost fixed regardless of app count, so it stays the design.)

## Key mechanics

- **Per-bot config lives in the conversation**, never the class/factory (DO instances of one class share isolates): `ensureBot()` → `pi().root()` → `configure({ model, instructions })`, re-applied idempotently after eviction; persists in `pi.agent`.
- **The roster is durable, the file is a seed.** The `Registry` Durable Object holds the fleet's bots and is the only writer: the web app reads it at `GET /bots` and writes to it, so a bot's prompt changes without a redeploy. `bots.json` fills a registry that has never been seeded and is inert afterwards.
- **Per-bot run policy** comes from the same declaration (the roster's `runtime`): pi reads `HarnessSettings` at every use and never stores it, so a bot that knows its context window compacts at thresholds scaled to it. One settings object for the whole fleet cannot suit a 32k and a 1M window alike.
- **What the harness reported is durable**: `onReport` writes to the bot's own table, and `/status` carries it beside the work the harness still has live. A bot that is stuck has to be able to say why.
- **Recovery is free**: eviction/crash/deploy mid-run → wake-up job alarm restarts the DO → Pi reopens storage, resumes from last checkpoint; `replay: "safe"` tools rerun, others surface as interrupted.
- **A crash-looping task parks.** The harness counts a task's restarts and parks it at `settings.restartLimit` instead of running it again, so a bot whose every turn crashes stops costing the fleet alarm invocations. `POST /retry/:bot` runs it again.
- **The approval rule is the harness's, not the prompt's.** A `ToolTask` hook refuses an `executor_resume` that no human decision vouches for, which is the one rule the prompt cannot enforce.
- **The wake alarm is the SDK's, not pi's.** pi's own `onWake` would let the host arm an alarm for the earliest sleep instead of a heartbeat, but `agents@0.28.1` does not forward it, and pi's `Harness.open` is only reached through the SDK's factory. Replacing the SDK's wake machinery is not worth a personal fleet's alarm bill; the fix belongs upstream.
- **Pi comes from npm.** The five `@earendil-works` packages are pinned to the same published version (`1.4.0`) in every manifest that needs them, so a fresh `bun install` gets a released build rather than a tarball built from a commit.
- **Pi Durable limitations to design around**: conversations can't be deleted yet (matters for the later per-chat sessions phase); pi's own event streams are snapshot-only with no resume cursor, so `apps/api/src/feed.ts` keeps a durable chunk log of its own, tags every frame with its stream generation, and replays a snapshot when a client's cursor is too old; a single model call streaming >15 min is cut off (alarm invocations cap at 15 min, harness hands off every 10).
- **Telegram flow (channel added last, optional)**: `setWebhook` with a per-bot `secret_token`; the front door validates `X-Telegram-Bot-Api-Secret-Token` on every update. Webhook handler only durably submits (`operationId`) and acks 200 immediately — webhook retries can't double-answer. The **DO sends the reply** via `sendMessage` when the submission settles, not the front door's `ctx.waitUntil` (multi-minute runs outlive a Worker request, and the PiHarness wake-up machinery already guarantees the DO survives to completion). Mid-run Telegram corrections use `whenBusy: "steer"` to join the running work instead of queueing as a follow-up.
- **Cron briefs**: `crons: ["0 * * * *"]` → per-bot `brief()` with stable `operationId`.
- **Secrets**: `.env` → `Config.Redacted` → `secret_text` → `process.env` via `nodejs_compat` (how pi-ai resolves `OPENCODE_API_KEY`).
- **Compaction** on (`reserveTokens: 16384`) so long-lived bots don't die on context.
- `/status` reporting backed by `pi.usage` → per-bot spend + exchange counts (built in v1).

## Expected cost

~$0–10/mo total for a personal fleet: models bill to the OpenCode Go plan quota; Executor free tier ($0 solo); Cloudflare free tier with the progress-interval tuning (default commit interval is 100ms, so 1000ms ≈ 10x fewer row writes). Fine print from the DO pricing page: alarm invocations count as requests (the Pi heartbeat fires every 30s while a bot works), every RPC method call on a DO stub is one request, every `setAlarm()` is a row write, duration is billed at 128MB regardless of actual use, and SQLite storage billing went live Jan 2026. Free limits — 100k requests/day, 100k row writes/day, 13,000 GB-s/day (≈ 29h of active DO time across the whole fleet), 5 GB stored — sit comfortably above personal volume, but one always-on chatty bot could approach the duration cap. $5 Workers Paid plan is the escape hatch; token spend is the only real variable.

## Verification checklist (known unknowns)

1. **Tool result shape**: discrepancy confirmed real — PiHarness docs show `{ content: [...] }`, pi-durable README shows `{ output, structuredOutput, details }` (transcript stores only `output`/`details`), and the README warns the experimental API "changes without notice between releases" (hence the pinned deps). Match `ToolRegistration` in the _pinned_ version; the bridge smoke test settles it.
2. **Executor v2 endpoint/key**: `EXECUTOR_URL` = org MCP URL (`https://mcp.executor.sh/org/<org-id-or-slug>/mcp`; self-host `<origin>/mcp`) + org-scoped PAT. ("Least-privilege API key" doesn't exist — PATs carry no permission/tool settings; see the scoping caveat in the bridge section.)
3. **Model IDs**: the catalog (fetched 2026-10) lives in `packages/contract/src/catalog.ts` and seeds `bots.json`; each id's thinking variants are declared there and served at `GET /models`. Shrunk to the 10 ids mackbot actually offers; add a model and its variants in one place.
4. **`alchemy dev` + AI-family bindings**: Alchemy v2 claims local emulation of Workers _and_ Durable Objects; the `AI` binding in dev is the part to verify, as is the `Cloudflare.DurableObject` resource's auto SQLite class migration claim. If flaky, dev against OpenCode Go directly or deploy a preview stage.
5. First deploy: `adopt(true)` only if a same-named Worker already exists (it shouldn't — fresh project).

## Implementation order

1. Scaffold project + pinned deps
2. `executor-mcp.ts` bridge + smoke test against live Executor (verifies tool shape, auth, and a paused-approval → `approvalUrl` → `resume` round-trip first)
3. `Bot` class + `bots.json` + front door — **HTTP is the v1 interface** (`POST /chat/:bot`, bearer auth)
4. `alchemy dev` local test via `POST /chat/:bot`
5. `bun run deploy` (HTTP API live)
6. `/status` + cron briefs
7. First-party webapp — **built**: home, transcripts, generation-guarded per-run SSE, approvals, stop/retry, and the roster editor. Still open: a composer for `POST /chat/:bot`, per-chat sessions, sandbox/"own computer" phase
8. **Telegram integration — last, and optional**: `setWebhook` per bot (with per-bot `secret_token`); approval buttons in that channel come later still

## Cross-bot memory (cut)

Pi Durable keeps memory per conversation (typed docs plus compaction), and one storage per harness means there is no sharing across bot DOs. Cross-bot memory was designed three times and cut on 2026-10-16, because it was never load-bearing and every route needed either a vendor or unrewarded work.

What was tried, and where each stopped:

- **A `memory` app of our own.** Two tables, five tools, one skill, and the app-authoring toolchain. Viable, but search would be keyword-only, since an Executor app has no embedding capability, and the write protocol and the trivia review would both have to be invented.
- **Mem0** (`@executor.sh/mem0`). One catalog entry, but its scoping fights the design. Passing both `user_id` and `agent_id` files each extracted fact under whichever of the two said it, so `{"AND": [...]}` returns nothing, and there is an open platform report that v3 stores neither, which would leave any filter advisory.
- **Kody** (installed from `https://kody.codes/mcp`). The closest fit, since it is built for exactly this and the installed app works. Two blockers. Its Executor surface is three generic tools (`search`, `execute`, `api`), and `api` is a mutation, so even `metaMemorySearch` pauses for human approval, which no unattended fleet can absorb. And its MCP OAuth grant is bound to `https://kody.codes/mcp`, confirmed by its own `auth.md` and Open API, so `api.kody.codes` is out of reach; that API wants a `kody_at_...` token.

If it returns, the shortest route is a wrapper app over Kody's REST API, `GET /v1/memories`, `POST /v1/memories`, `POST /v1/memories/verify`, and `GET`/`DELETE /v1/memories/{memory_id}`, with a `secrets` account holding a `kody_at_...` token, reads on `approval: never()` and writes on `always()`.

## Setup inputs

1. `EXECUTOR_URL` (org URL, no query) + org-scoped PAT (`EXECUTOR_TOKEN`); Executor setup: install apps, connect accounts (dashboard / connection links — never via chat), create per-app profiles, note profile IDs
2. Bot roster: names, model per bot (Telegram tokens via BotFather only if/when that channel lands)
3. Cloudflare auth for deploys — Alchemy stores credentials in profiles (`~/.alchemy/profiles.json`, set via `alchemy profile edit` or the first `alchemy deploy`); no wrangler login or exported `CLOUDFLARE_API_TOKEN`
4. Model per bot from the `opencode-go` catalog (fetched 2026-10; verify thinking variants per model)

## References

- Pi: https://github.com/earendil-works/pi · https://pi.dev
- Pi Durable: packages/durable in the pi repo
- PiHarness (Cloudflare Agents SDK): https://developers.cloudflare.com/agents/harnesses/pi
- Alchemy v2: https://alchemy.run (Workers guide: /cloudflare/compute/workers)
- Executor: https://executor.sh/docs (MCP: /docs/mcp · API keys: /docs/api-keys · accounts: /docs/connect-an-account · approvals: /docs/concepts/tools-and-approvals · pricing: /pricing)
- Cloudflare DO pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Grok Bot (inspiration): https://x.ai/bot
