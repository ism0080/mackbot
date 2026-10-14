# mackbot — remaining feature work

This file now lists only the work that is still outstanding. The following
foundation pieces are already implemented and are intentionally omitted here:

- Durable bot registry config extensions: `delegatesTo`, `sharedMemory`, and
  `budgets`, with validation.
- Delegation enforcement for the optional `delegatesTo` allowlist.
- Shared-memory prompt/config seam (`src/memory.ts`).
- Optional durable conversation/thread IDs in `POST /chat/:bot`, including
  per-thread pi session creation and SQLite mapping.
- Audit-log storage seam (`src/audit-log.ts`).
- Sandbox/workspace abstraction scaffold (`src/sandbox.ts`).
- Existing meta-tool bridge, cron briefs, approvals via browser links, and
  compaction configuration.

## Product and UX

- **Durable stream resumption.** Replace snapshot-only SSE reconnect behavior
  with a monotonic commit/entry cursor so clients can resume from
  `Last-Event-ID` and fall back to a full snapshot only when the cursor is too
  old.
- **In-product approval controls.** Add `model` mode with approve/deny buttons in
  the chosen channel, then call `resume(requestId, answer)`. Keep browser links
  as a fallback.
- **Saved routines (“show me once”).** Allow a user to record a workflow and
  store it as a reusable routine, then run it on a schedule with approval gates.
- **Bot presets / marketplace config.** Evolve `bots.json` into versioned presets
  with model, prompt, delegates, memory scopes, approved tools, and channel
  bindings.
- **Shared workspaces across bots.** Move beyond the scaffold to a real shared
  file/workspace capability with provenance fields identifying the bot that
  created or changed each artifact.
- **Attachment/media support.** Add durable storage for files, screenshots,
  reports, and artifacts produced by bot work.
- **Richer task lifecycle labels.** Distinguish chat inputs, cron briefs,
  delegated tasks, approval retries, and memory writes in `/status` and usage.

## Runtime and durability

- **Fiber-like recovery for long turns.** Checkpoint intermediate progress around
  expensive work so a restarted Durable Object can resume without restarting the
  whole turn.
- **Explicit interrupted-state reporting.** Surface interrupted unsafe calls as
  an explicit state in `/status` so a human can decide what to do next.
- **Asynchronous delegation.** Add async fire-and-poll delegation, richer thread
  lineage, and stronger anti-livelock behavior. The basic `delegatesTo`
  allowlist is implemented.
- **Per-bot budget enforcement.** Add optional token, time, or spend soft caps
  with visibility in `/status`. Config fields exist; runtime enforcement does
  not yet.
- **Operation taxonomy.** Label submitted work by origin (`http`, `cron`,
  `delegate`, `approval`, `thread`) in status, usage, and audit records.
- **Memory compaction automation.** Use compaction as a trigger for distilling
  durable cross-bot facts into the shared memory app, as already designed.
- **Audit-runtime integration.** Wire the audit-log seam into chat, delegation,
  approval, memory, and sandbox flows instead of leaving it standalone.
- **Full sandbox graduation.** Replace the scaffold with durable virtual
  filesystem and dynamic code execution, reserving containers for native tools,
  git, package installation, or compilers.

## Tooling and sandbox

- **Dynamic code execution runtime.** Execute agent-generated programs in Dynamic
  Worker isolates with the bindings and output limits appropriate for bots.
- **Account connection as a first-class flow.** Let a human obtain and complete a
  connection link and select profiles without exposing secrets in chat.
- **Tool provenance in memory.** When a bot records a fact, retain which tool,
  profile, account, and conversation produced it.
- **Provider/model fallback.** Add fallback tiers (free, cheap, premium) per bot
  and make them visible in status.

## Channels and integration

- **Telegram adapter.** Add optional Telegram support as an adapter over the same
  submit, wait, resume, and status primitives. It should remain last/optional.
- **Additional channel adapters.** Reuse proven implementations for Discord,
  Slack, or other platforms instead of hand-rolling each one.
- **Service binding access.** Allow private Workers or applications to reach bots
  through a Cloudflare service binding rather than only the public HTTP route.
- **Attachment downloads.** Ensure artifact URLs work through the same binding or
  channel APIs without exposing credentials.
- **Scheduled approval patterns.** Support sleeps, timers, and human approval
  waits inside long-running scheduled work.

## Cost, observability, and governance

- **Spend controls.** Add per-bot and per-conversation spend tracking, soft
  caps, and provider-specific limits beyond config declarations.
- **Tracing.** Add agent, model-turn, and tool-call spans with standard GenAI
  attributes.
- **Memory review cadence.** Prevent trivia accumulation by adding confidence,
  review, or decay mechanisms for distilled facts.
- **Cost posture monitoring.** Track Durable Object duration, storage, alarm
  usage, and free-tier tuning effectiveness.

## Suggested priority

1. Durable stream resumption and approval buttons.
2. Real sandbox graduation and dynamic code execution.
3. Async delegation and thread lineage.
4. Bot presets and saved routines.
5. Telegram adapter and additional channels.
6. Spend controls, tracing, and audit-runtime integration.