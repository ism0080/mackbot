# mackbot — feature ideas

Ideas drawn from Grok Bot, Pi Durable, Cloudflare Agents, and Flue that could
strengthen mackbot without replacing its core architecture. Items are grouped
roughly by product, runtime, tooling, channels, and operational concerns. They
are meant to feed the roadmap, not to be implemented all at once.

## Product and UX

- **Per-chat conversations now, not later.** Add `conversation` / `threadId` to
  `POST /chat/:bot`. Keep the root session as the bot’s global workspace, but
  route user chat work into fresh or forked sessions. This is the foundation for
  Grok Bot-style multi-thread teammates.
- **Durable stream resumption.** If/when SSE lands, include a monotonic
  commit/entry sequence on every event and allow reconnects to resume from
  `Last-Event-ID`. Fall back to a full snapshot only when the requested cursor
  is too old.
- **In-product approval controls.** Grok Bot-style `model` mode should provide
  approve/deny buttons in the channel, then call `resume(requestId, answer)`.
  Keep browser links as the v1 fallback.
- **Saved routines (“show me once”).** Allow a user to record a workflow and
  store it as a reusable routine (Executor app / durable document), then run it
  on a schedule with approval gates.
- **Bot presets / marketplace config.** Evolve `bots.json` into versioned
  presets that include model, system prompt, `delegatesTo`, memory scopes,
  approved tools, and channel bindings.
- **Shared workspaces across bots.** Provide an early “shared files” or virtual
  filesystem app, with provenance fields identifying the bot that created or
  changed each artifact.
- **Attachment/media support.** Add durable storage for files, screenshots,
  reports, and other artifacts produced by bot work.
- **Richer task lifecycle labels.** Distinguish chat inputs, cron briefs,
  delegated tasks, approval retries, and memory writes in `/status` and usage.

## Runtime and durability

- **Fiber-style recovery for long turns.** Around expensive work, checkpoint
  intermediate progress so a restarted Durable Object can resume or finish
  without starting the whole turn over.
- **Explicit interrupted-state reporting.** Keep the “never blindly replay
  interrupted unsafe calls” rule, but surface those calls as an explicit
  `interrupted` state in `/status` so a human can decide what to do next.
- **Bounded delegation.** Add `delegatesTo` allowlists, async fire-and-poll
  delegation, and richer thread lineage instead of relying only on long-poll
  timing.
- **Per-bot budgets.** Add optional token, time, or spend soft caps per bot with
  visibility in `/status`, useful for long-running personal fleets.
- **Operation taxonomy.** Label submitted work by origin (`http`, `cron`,
  `delegate`, `approval`) so later analytics and memory work can distinguish it.
- **Memory compaction as a product signal.** Use compaction events as triggers
  for distilling cross-bot facts into the shared memory app, as described in the
  late todo.

## Tooling and sandbox

- **Graduate the sandbox seam.** Keep the `ExecutionEnv` / Executor seam, then
  add a low-cost virtual workspace for text/file/query work and full containers
  only for native tools, git, package installation, or compilers.
- **Dynamic code execution.** Use Dynamic Worker isolates for small agent-generated
  programs before reaching for a full container.
- **Preserve the meta-tool bridge.** Continue routing all real tools through
  Executor’s fixed six meta-tools so bot context cost stays stable as apps grow.
- **Account connection as a first-class flow.** Eventually let a human get a
  connection link and poll status without exposing secrets in chat.
- **Tool provenance in memory.** When a bot records a fact, retain which tool,
  profile, account, and conversation produced it.

## Channels and integration

- **Keep HTTP canonical.** `POST /chat/:bot` remains the v1 interface, with
  Telegram, Discord, Slack, and others acting as adapters over the same submit,
  wait, resume, and status primitives.
- **Service binding access.** Allow private Workers or applications to reach bots
  through a Cloudflare service binding rather than only the public HTTP route.
- **Durable attachment downloads.** Ensure artifact URLs work through the same
  binding or channel APIs without exposing credentials.
- **Scheduled delivery.** Support schedules inside Durable Objects and Worker
  cron triggers, including “park until approval” patterns for long-running work.
- **Channels as later adapters.** Reuse proven channel implementations where
  possible instead of hand-rolling every platform.

## Cost, observability, and governance

- **AI gateway and spend controls.** Track per-bot and per-conversation spend,
  enforce soft caps, and allow model-tier fallbacks (free, cheap, premium).
- **Tracing.** Add agent, model-turn, and tool-call spans with standard GenAI
  attributes so expensive or failed work can be inspected.
- **Compaction and memory review cadence.** Prevent trivia accumulation by
  adding a review or confidence mechanism for distilled facts.
- **Audit trail.** Record approvals, delegations, tool calls, memory writes, and
  sandbox actions with timestamp, bot, and conversation.
- **Cost posture checks.** Keep free-tier tuning such as reduced progress commit
  intervals, and monitor Durable Object duration, storage, and alarm usage.
- **Provider safety.** Never let bots accept, read, or reuse secrets in chat;
  continue connecting accounts only through dashboard, connection links, or
  approved flows.

## Suggested priority

1. Thread/conversation IDs plus durable resume cursor.
2. Sandbox/computer seam graduation.
3. Approval buttons instead of links.
4. Cross-bot memory scopes and provenance.
5. Bot presets, routines, and marketplace-style configuration.
6. Additional channels and attachments.
7. Advanced tracing, audit, and spend governance.