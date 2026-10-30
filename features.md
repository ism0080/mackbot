# mackbot — remaining feature work

This file now lists only the work that is still outstanding. The following
foundation pieces are already implemented and are intentionally omitted here:

- Durable bot registry config extension: the optional `delegatesTo` allowlist,
  with validation.
- Delegation enforcement for the optional `delegatesTo` allowlist.
- Optional durable thread IDs in `POST /chat/:bot`, including per-thread pi
  session creation and SQLite mapping.
- Audit-log storage seam (`apps/api/src/audit-log.ts`).
- Existing meta-tool bridge, cron briefs, approvals in model mode, and
  compaction configuration.
- Per-bot run policy in `bots.json` (`runtime`), and a durable commitments
  document for the bots that declare `commitments`.
- Harness-side enforcement of the approval rule, and a durable record of what
  the harness reported.
- A stop: `POST /abort/:bot` ends a bot's current work, and the home screen
  has a Stop button.
- A crash-loop guard: a task cut off too many times is parked, and
  `POST /retry/:bot` runs it again.
- A durable wait for an approval, so a decision cannot be lost between the
  row being written and the call being resumed.
- A durable bot roster: the `Registry` Durable Object holds the fleet's bots,
  and the web app edits a bot's prompt, model, brief and thinking level and
  adds a bot without a redeploy. `bots.json` seeds a fresh registry and is
  inert afterwards.
- Durable stream resumption: every frame carries its stream generation, a run's
  stream rotates to a new segment only at the chunk ceiling, and
  `Last-Event-ID` / `?from=` / `?gen=` resume where the client left off or fall
  back to a snapshot instead of skipping the head.
- Approval controls in the web app: a paused call becomes a durable approval,
  the app's cards decide allow or deny, and the decision steers the resume.
  Other channels still need their own controls.
- Sign-in hardening: `/login` is rate-limited per client by Cloudflare's
  rate-limiting binding, and `POST /logout`
  clears the session cookie from the web app's sign-out.
- Retention: the hourly cron prunes each bot's audit rows, recorded failures
  and settled approvals past their retention.
- A delegation depth limit: a chain of hand-offs is refused past three.

## Product and UX

- **Saved routines (“show me once”).** Allow a user to record a workflow and
  store it as a reusable routine, then run it on a schedule with approval gates.
- **Bot presets / marketplace config.** The roster is durable now and the web
  app edits it. Still open: versioned presets a bot can be restored to, the
  approved-tools list, and channel bindings.
- **Deleting a bot.** The roster's write path can add and replace a bot, but
  not remove one. A removed bot leaves its Durable Object with its transcripts,
  audit rows and commitments, and the Worker cannot delete an instance, so the
  delete route has to decide what happens to that history first.
- **Editing a bot's delegate list and run policy.** The web app edits the
  model, the thinking level, the prompt and the brief. The delegate list and
  the `commitments` flag are carried through a save untouched, so they cannot
  be changed there yet. The delegate list has a rule of its own: absent means
  the bot may delegate to any bot, an empty list means it may delegate to
  none. The commitments extension is installed when the harness opens, so
  flipping that flag needs a restart, while a run policy edit lands on the
  bot's next submit.
- **Shared workspaces across bots.** Add a real shared file/workspace capability
  with provenance fields identifying the bot that created or changed each
  artifact.
- **Attachment/media support.** Add durable storage for files, screenshots,
  reports, and artifacts produced by bot work.
- **Richer task lifecycle labels.** Distinguish chat inputs, cron briefs,
  delegated tasks, and approval retries in `/status` and usage.

## Runtime and durability

- **Fiber-like recovery for long turns.** Checkpoint intermediate progress around
  expensive work so a restarted Durable Object can resume without restarting the
  whole turn.
- **Explicit interrupted-state reporting.** `/status` now reports the failures
  the harness reported, in pi's own words (a failed session, a faulted task, a
  parked one, a broken migration), and the work it still has live, so a stuck
  bot says why. Still open: an interrupted unsafe call, as opposed to a harness
  failure, is not yet a state of its own that a human can decide about.
- **Asynchronous delegation.** Add async fire-and-poll delegation, richer thread
  lineage, and stronger anti-livelock behavior. The basic `delegatesTo`
  allowlist and the depth limit are implemented.
- **Delegation that survives a crash.** `delegate_to_bot` is still an unsafe
  replay: an eviction mid-delegation leaves the model with an interrupted
  result. Its operation id makes the submission idempotent, so deriving it
  from the tool call's own task id would make the delegation replay-safe.
- **Remaining operation taxonomy.** Origin labelling covers `http`, `cron`, and
  `delegate` in `/status` and in audit records. Still open: a queryable `origin`
  column on the audit table (the value lives in `detail`, and the operation id
  prefix already carries it), approval turns labelled as their own origin, and
  per-origin spend, which `pi.usage` does not track because it belongs to the
  harness.
- **Audit-runtime integration.** The audit seam now records submissions,
  settlements, stops and Executor calls. Still open: the delegation and
  approval flows are not audited.
- **Sandbox and workspace.** Add a durable virtual filesystem and dynamic code
  execution, reserving containers for native tools, git, package installation,
  or compilers.

## Tooling and sandbox

- **Dynamic code execution runtime.** Execute agent-generated programs in Dynamic
  Worker isolates with the bindings and output limits appropriate for bots.
- **Account connection as a first-class flow.** Let a human obtain and complete a
  connection link and select profiles without exposing secrets in chat.
- **Provider/model fallback.** Add fallback tiers (free, cheap, premium) per bot
  and make them visible in status.

## Channels and integration

- **Additional channel adapters.** Reuse proven implementations for Discord,
  Slack, or other platforms instead of hand-rolling each one.
- **Service binding access.** Allow private Workers or applications to reach bots
  through a Cloudflare service binding rather than only the public HTTP route.
- **Attachment downloads.** Ensure artifact URLs work through the same binding or
  channel APIs without exposing credentials.
- **Scheduled approval patterns.** Support sleeps, timers, and human approval
  waits inside long-running scheduled work.

## Cost, observability, and governance

- **Spend controls.** Add per-bot and per-conversation spend tracking, soft caps,
  and provider-specific limits. A `bots.json` budget config was removed on
  2026-10-16 because it validated and then did nothing, so reintroduce it
  together with the enforcement that reads it rather than ahead of it.
- **Tracing.** Add agent, model-turn, and tool-call spans with standard GenAI
  attributes.
- **Cost posture monitoring.** Track Durable Object duration, storage, alarm
  usage, and free-tier tuning effectiveness.

## Suggested priority

1. Sandbox and workspace graduation and dynamic code execution.
2. Async delegation and thread lineage.
3. Bot presets and saved routines.
4. Additional channels.
5. Spend controls, tracing, and audit-runtime integration.
