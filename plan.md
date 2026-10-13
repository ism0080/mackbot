# mackbot — personal AI teammate fleet

> Modeled on [Grok Bot](https://x.ai/bot) (xAI): AI teammates you give real work to.
> Self-hosted on Cloudflare Workers + Executor v2. Hermes-style always-on durability underneath — Grok Bot-style product on top.

---

## Vision

Grok Bot's pitch: bots you message like teammates — they sign into your tools, keep context on how you work, run 24/7 in parallel, come back when your approval is needed, and get smarter over time.

mackbot is the self-hosted version of that: a fleet of durable agent bots, each with a job, an identity, a model, and a system prompt — reachable from anything via HTTP (first-party webapp to follow; Telegram as an optional phone channel, added last) — with all real tooling routed through one Executor MCP endpoint.

### Grok Bot → mackbot mapping

| Grok Bot concept | mackbot v1 | Later phase |
|---|---|---|
| Bots with jobs (Sales Outbound, Chief of Staff, …) | One bot per job, declared in `bots.json` (own model, system prompt; Telegram identity optional) | Reusable bot presets (own "marketplace") |
| Message bots like teammates | Headless HTTP API (`POST /chat/:bot`) | First-party webapp (SSE), Telegram DMs (added last), more channels (Discord, …) |
| 24/7, survives everything | Pi Durable in SQLite-backed Durable Objects; wake-up alarms resume mid-run after eviction/crash/deploy | — |
| "Own computer" / shared cloud computer | Executor v2 apps hold all real tools and accounts (bots stay thin) | Shared workspace per user: sandbox phase — Daytona / Cloudflare Containers / homelab remote `ExecutionEnv` |
| Routines on a schedule | Cron Triggers → per-bot briefs (stable `operationId` = at-most-once) | "Show me once" workflow capture → saved routine |
| Memory, smarter over time | Per-conversation typed docs + automatic compaction | Cross-bot shared memory via a `memory` Executor app (late todo, see below) |
| Approvals / Auto Review | Executor approvals guard server-side; `browser` elicitation mode — paused call returns an `approvalUrl` surfaced over the HTTP API / event stream (a Telegram link once that channel lands), `resume` collects the answer; unsafe tools never auto-replay | `model` elicitation mode: approve/deny buttons in Telegram, answered via `resume` |
| Bots in one thread passing work | Built-in `delegate_to_bot` pi tool: any bot submit()s a task to another bot's DO and long-polls (55s) or returns a receipt; unsafe replay; approval links relayed in the answer. No per-bot gating (any→any) in v1 | Bot-to-bot delegation hardening: `delegatesTo` allowlists in bots.json, fire-and-poll / async callbacks, and richer multi-bot threading |

Infrastructure pattern is the Hermes one (always-on durable agent harness). Product shape is Grok Bot: a fleet of teammates with jobs, not one general assistant.

---

## Architecture

```
POST /chat/:bot (v1 interface)  ·  cron (hourly)  ·  Telegram webhooks (optional, added last)
                    │
           Front-door Worker  (single, plain fetch/scheduled handlers)
                    │  validate HTTP bearer (Telegram secret_token when added) → botId from bots.json;  env.Bot.getByName(botId)
     ┌──────────────┼──────────────┐
     ▼              ▼              ▼
 Bot:hermes     Bot:scribe      Bot:…        one DO instance per bot
 PiHarness      PiHarness       …           SQLite state, wake-up alarms
 opencode-go    opencode-go     …           per-bot model + system prompt (pi.agent)
     └──────────────┼──────────────┘
                    ▼  MCP meta-tools (streamable HTTP · org URL · browser approvals · PAT bearer)
              Executor v2  (public endpoint; apps hold all real tools & accounts)
```

## Locked decisions

| Decision | Choice |
|---|---|
| Runtime / durability | Pi Durable via Cloudflare Agents SDK `PiHarness` (beta) in SQLite-backed Durable Objects |
| Deploy tooling | **Alchemy v2** (async Worker + `Cloudflare.DurableObject` binding — auto SQLite class migrations; no wrangler) |
| Bot topology | **One DO instance per bot** (`getByName(botId)`), root session each |
| Per-bot config | **`bots.json` in code** (model, thinking level, system prompt, telegramTokenEnv); applied idempotently via `pi()` → `root.configure()` |
| Models | **OpenCode Go** (`opencode-go` provider, `OPENCODE_API_KEY`); cheap tier: Workers AI (`@cf/...`) or free catalog models (`longcat-2.5-preview-free`, `step-5-preview-free`) |
| Tooling | **Executor v2 meta-tools only** — bots never talk to apps directly |
| Channels | **HTTP API first** (`POST /chat/:bot` + bearer auth); first-party webapp later (SSE events); **Telegram last, optional** |
| Idempotency | `operationId` = `tg:<chatId>:<messageId>` / `cron:<scheduledTime>` — at-most-once admission across retries/evictions |
| Ingress auth | Bearer secret on the `POST /chat/:bot` route (the v1 surface — anyone who finds the URL could otherwise drive the bots and their Executor spend); when Telegram lands: per-bot webhook `secret_token`, validate `X-Telegram-Bot-Api-Secret-Token` on every update |
| Cost posture | Free tier first: `progress: { partialIntervalMs: 1000, outputIntervalMs: 1000 }` (~10x fewer SQLite row writes); Workers Paid ($5) only if limits trip |
| Sandboxing (Daytona etc.) | **Deferred** — seam preserved (`ExecutionEnv` / Executor app); revisit when a bot needs to build/run things (Grok Bot's "own computer" phase) |
| Executor hosting | Free tier (solo, $0) or self-host — both work; `EXECUTOR_URL` = org MCP URL + `?elicitation_mode=browser`, `EXECUTOR_TOKEN` = org-scoped PAT |

## Project layout

```
mackbot/
├── alchemy.run.ts       # Worker, Bot DO binding, AI binding, crons, secrets (Config.Redacted)
├── bots.json            # bot registry (typed loader in src/bots.ts)
├── oxlint.config.ts     # lint config — core profile on everything, effect profile on alchemy.run.ts only (src/ is Pi-based plain TS)
├── package.json         # lint/format/tools:oxlint scripts + lint tooling deps (grows at scaffold time)
├── .env                 # EXECUTOR_URL (org URL + ?elicitation_mode=browser) / EXECUTOR_TOKEN (org-scoped PAT), per-bot Telegram tokens, OPENCODE_API_KEY
├── tools/oxlint/        # vendored @ism0080/oxlint-plugin-forge (copied from the forge repo; self-contained, builds + tests green)
└── src/
    ├── index.ts         # Bot class (PiHarness + ensureBot) + front door fetch + scheduled
    ├── bots.ts          # typed bots.json loader + modelRef resolution
    └── executor-mcp.ts  # Executor v2 bridge (6 meta-tools, MCP TS SDK streamable HTTP)
```

Dependencies (all pinned): `alchemy`, `effect`, `agents`, `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, `@earendil-works/chord`, `@modelcontextprotocol/sdk`. No hono/grammy — plain `fetch` handlers.

Lint tooling (vendored from the forge repo, already in place): `tools/oxlint/` holds the `@ism0080/oxlint-plugin-forge` rule set (anti-slop / effect / react / xstate profiles). Root `oxlint.config.ts` enables the core profile on everything and the effect profile on `alchemy.run.ts` only (src/ is Pi-based plain TS — Effect-idiom rules like `no-direct-fetch`/`no-try-catch` would fight Pi's design); the plugin's own source is ignored by the root config and verifies itself via `bun run tools:oxlint` (tsc build + vitest + smoke). The react/xstate profiles come into play if the first-party webapp lands. Scripts: `lint` / `format` (oxfmt) / `tools:oxlint`.

`bots.json` sketch:

```jsonc
{
  "hermes": {
    "model": { "provider": "opencode-go", "modelId": "deepseek-v4-pro" },
    // thinkingLevel must be one of the model's variants — they differ per model
    // (deepseek-v4-pro supports only "high"/"max"; glm-5.3 has "low"/"high"/"max")
    "thinkingLevel": "high",
    "systemPrompt": "You are … (job description + executor protocol) …",
    "telegramTokenEnv": "TELEGRAM_TOKEN_HERMES",        // Telegram fields optional —
    "telegramSecretTokenEnv": "TELEGRAM_SECRET_HERMES"  // that channel is added last
  }
}
```

Model may also be a `"@cf/..."` string (Workers AI via the `AI` binding). The opencode-go catalog (22 models as of 2026-10) includes two **free** ones — `longcat-2.5-preview-free` and `step-5-preview-free`, $0 in/out — a natural cheap tier for low-stakes bots.

## Executor v2 bridge

Six meta-tools, all exposed as pi tools (context cost stays fixed as apps grow — the endpoint's tool list never grows with apps):

| pi tool | Wraps | Replay | Use |
|---|---|---|---|
| `executor_search` | `executor.search` | safe | Discover tools by words/namespace |
| `executor_describe` | `executor.describe` | safe | Full signatures before calling |
| `executor_call` | `executor.call` | **unsafe** | One/few direct `{path, input}` calls (array runs concurrently) |
| `executor_execute` | `executor.execute` | **unsafe** | JS program when one call feeds another or results need filtering |
| `executor_skills` | `executor.skills` | safe | Read an app's instructions before first use |
| `executor_resume` | `executor.resume` | **unsafe** | Answer a paused approval/input request (unsafe: it's the call that authorizes the effect) |

`resume` is not optional: in `model` and `browser` elicitation modes, any approval-gated call pauses and returns a pending `requestId` — without `resume` the bridge stalls forever on the first such call. (`native` mode has no `resume` but needs a form-elicitation MCP client — not the pi path.)

**Elicitation mode: `browser` for v1.** With a PAT the mode is chosen by URL query (`?elicitation_mode=browser`). A paused call returns an `approvalUrl`; the bot surfaces the link in its channel — HTTP response / event stream for the webapp, a Telegram message once that channel lands ("come back when your approval is needed" — Grok Bot style) — then calls `resume({ requestId })` to collect the answer. `model` mode (bot relays the question itself; Telegram approve/deny buttons) is the natural later phase.

The extension's prompt section teaches the protocol: search → describe → call for direct work, execute for composition, skills before first use of an app — and that `search` returns exact profile paths for account-backed apps (`tools.<app>.profiles["<profile-id>"]...`). After an eviction, unsafe calls surface as "interrupted" and the model decides — never auto-replayed. Executor-side restarts are the same deal: resuming a program after a server restart is not supported, and a lost session must not be re-run automatically.

**Auth**: org MCP URL — hosted `https://mcp.executor.sh/org/<org-id-or-slug>/mcp?elicitation_mode=browser`, self-host `<origin>/mcp?...` — with an **org-scoped PAT** as bearer (`EXECUTOR_TOKEN`). Caveats: a full-account PAT on the bare `/mcp` URL needs an `X-Executor-Organization` header; PATs have no permission/tool-selection settings of their own, so org scope is the practical ceiling on hosted. Scoped connections (`/mcp?connection=<id>` — per-app profiles, all/read-only/picked tools) are the documented way to limit an agent, but they follow OAuth grants and "personal access tokens … are not limited by a connection"; verify a PAT at a connection URL actually scopes before relying on it, or accept org scope (self-host controls exposure at the app level instead).

**Accounts & profiles** (human-side setup): connect each account once per provider via the dashboard or a connection link — an agent must never take a secret in chat or read a token out of files. Each app's profile selects which account its tools use; profile IDs appear in tool paths. Future Grok-Bot-style flow: `accountConnect.issue` hands the human a connection link (30-min expiry, poll `accountConnections.get` until `Completed`).

Implementation: `@modelcontextprotocol/sdk` `StreamableHTTPClientTransport` (works on Workers with `nodejs_compat`), per-call connection (eviction-proof) or cached on the DO instance; bearer token from `EXECUTOR_TOKEN`. Set the client's tool-call timeout well above the common 60s default — `execute` programs run up to 5 minutes server-side, and time waiting for approval doesn't count against the server limit but does tick the client clock. (Fallback if six meta-tools ever feel heavy: pi-durable ships `createToolSearchExtension()` for large deferred tool sets "such as an MCP server's" — but the meta-tool bridge keeps context cost fixed regardless of app count, so it stays the design.)

## Key mechanics

- **Per-bot config lives in the conversation**, never the class/factory (DO instances of one class share isolates): `ensureBot()` → `pi().root()` → `configure({ model, instructions })`, re-applied idempotently after eviction; persists in `pi.agent`.
- **Recovery is free**: eviction/crash/deploy mid-run → wake-up job alarm restarts the DO → Pi reopens storage, resumes from last checkpoint; `replay: "safe"` tools rerun, others surface as interrupted.
- **Pi Durable limitations to design around**: conversations can't be deleted yet (matters for the later per-chat sessions phase); event streams are snapshot-only with no resume cursor (matters for the SSE route — a reconnecting client gets a fresh snapshot); a single model call streaming >15 min is cut off (alarm invocations cap at 15 min, harness hands off every 10).
- **Telegram flow (channel added last, optional)**: `setWebhook` with a per-bot `secret_token`; the front door validates `X-Telegram-Bot-Api-Secret-Token` on every update. Webhook handler only durably submits (`operationId`) and acks 200 immediately — webhook retries can't double-answer. The **DO sends the reply** via `sendMessage` when the submission settles, not the front door's `ctx.waitUntil` (multi-minute runs outlive a Worker request, and the PiHarness wake-up machinery already guarantees the DO survives to completion). Mid-run Telegram corrections use `whenBusy: "steer"` to join the running work instead of queueing as a follow-up.
- **Cron briefs**: `crons: ["0 * * * *"]` → per-bot `brief()` with stable `operationId`.
- **Secrets**: `.env` → `Config.Redacted` → `secret_text` → `process.env` via `nodejs_compat` (how pi-ai resolves `OPENCODE_API_KEY`).
- **Compaction** on (`reserveTokens: 16384`) so long-lived bots don't die on context.
- `/status` reporting backed by `pi.usage` → per-bot spend + exchange counts (built in v1).

## Expected cost

~$0–10/mo total for a personal fleet: models bill to the OpenCode Go plan quota; Executor free tier ($0 solo); Cloudflare free tier with the progress-interval tuning (default commit interval is 100ms, so 1000ms ≈ 10x fewer row writes). Fine print from the DO pricing page: alarm invocations count as requests (the Pi heartbeat fires every 30s while a bot works), every RPC method call on a DO stub is one request, every `setAlarm()` is a row write, duration is billed at 128MB regardless of actual use, and SQLite storage billing went live Jan 2026. Free limits — 100k requests/day, 100k row writes/day, 13,000 GB-s/day (≈ 29h of active DO time across the whole fleet), 5 GB stored — sit comfortably above personal volume, but one always-on chatty bot could approach the duration cap. $5 Workers Paid plan is the escape hatch; token spend is the only real variable.

## Verification checklist (known unknowns)

1. **Tool result shape**: discrepancy confirmed real — PiHarness docs show `{ content: [...] }`, pi-durable README shows `{ output, structuredOutput, details }` (transcript stores only `output`/`details`), and the README warns the experimental API "changes without notice between releases" (hence the pinned deps). Match `ToolRegistration` in the *pinned* version; the bridge smoke test settles it.
2. **Executor v2 endpoint/key**: `EXECUTOR_URL` = org MCP URL (`https://mcp.executor.sh/org/<org-id-or-slug>/mcp?elicitation_mode=browser`; self-host `<origin>/mcp?...`) + org-scoped PAT. ("Least-privilege API key" doesn't exist — PATs carry no permission/tool settings; see the scoping caveat in the bridge section.)
3. **Model IDs**: catalog fetched 2026-10 — 22 models (e.g. `glm-5.3`, `kimi-k2.7-code`, `claude-haiku-5-5`, `deepseek-v4-pro`, plus free `longcat-2.5-preview-free` / `step-5-preview-free`). Remaining: pin exact IDs in `bots.json` and check each model's thinking variants (they differ per model).
4. **`alchemy dev` + AI-family bindings**: Alchemy v2 claims local emulation of Workers *and* Durable Objects; the `AI` binding in dev is the part to verify, as is the `Cloudflare.DurableObject` resource's auto SQLite class migration claim. If flaky, dev against OpenCode Go directly or deploy a preview stage.
5. First deploy: `adopt(true)` only if a same-named Worker already exists (it shouldn't — fresh project).

## Implementation order

1. Scaffold project + pinned deps
2. `executor-mcp.ts` bridge + smoke test against live Executor (verifies tool shape, auth, and a paused-approval → `approvalUrl` → `resume` round-trip first)
3. `Bot` class + `bots.json` + front door — **HTTP is the v1 interface** (`POST /chat/:bot`, bearer auth)
4. `alchemy dev` local test via `POST /chat/:bot`
5. `bun alchemy deploy` (HTTP API live)
6. `/status` + cron briefs
7. Later (optional): first-party webapp on the SSE events route (PiHarness exposes each session's event stream; reconnects are snapshot-only — see Pi limitations above), per-chat sessions, sandbox/"own computer" phase
8. **Telegram integration — last, and only if the webapp doesn't replace it as the phone surface**: `setWebhook` per bot (with per-bot `secret_token`); approval buttons via `model` elicitation mode come later still
9. Late todo: cross-bot shared memory (Executor app) — see below

## Late todo: cross-bot shared memory (Executor app)

Pi Durable keeps memory per conversation (typed docs + compaction), and one storage per harness means there is no built-in sharing across bot DOs. Shared memory lives in a **`memory` app on our Executor** instead: one seam every agent already uses (bots *and* OpenCode agents), approvals can guard writes, and the app can ship a dashboard UI for browsing memory. Design settled 2026-10-13:

- **App tools**: `memory.remember` (fact + scope + tags, keyed upsert), `memory.recall` (search by words/scope), `memory.forget` (archive). Every row carries provenance: which bot, which conversation, when.
- **Bot-side bridge**: a small pi extension per bot with
  - a stable `memory` prompt section — index only (scopes + "use memory_search"), so provider prompt caches stay warm (confirmed in pi-durable docs: sections re-render only on change, and each conversation's UUIDv7 in `pi.provider` gives provider session affinity);
  - a `memory_search` pi tool (`replay: "safe"`) — lazy reads on demand;
  - a `remember` pi tool (`replay: "unsafe"` until writes are keyed upserts).
- **Write paths**: explicit `remember` calls (the "noted for next time" moment) **plus automatic distillation**: a `beforeCompact` hook on `CompactionTask` so the compaction pass that already runs for context reasons also extracts durable cross-bot facts — one model pass, double duty.
- **Per-bot scopes** in `bots.json`: `"sharedMemory": { "read": ["homelab", "family"], "write": ["homelab"] }`.
- **Conflicts**: append-only log + timestamps; materialized last-writer-wins view; provenance surfaced in `/status` ("Updated memory for …", Grok Bot style).
- **Gotchas**: route scope-changing writes through Executor approvals (later surfaced as Telegram buttons); give distilled facts a review cadence so trivia doesn't accumulate.

## Open inputs (before implementation)

1. `EXECUTOR_URL` (org URL + `?elicitation_mode=browser`) + org-scoped PAT (`EXECUTOR_TOKEN`); Executor setup: install apps, connect accounts (dashboard / connection links — never via chat), create per-app profiles, note profile IDs
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
