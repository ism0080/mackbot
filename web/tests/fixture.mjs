/*
 * The payloads the two documented routes used to be faked by. They are test
 * data now: `support/stub.mjs` serves them over a real HTTP boundary, and the
 * test harness decodes them with the same Schemas the app decodes with, so the
 * fixture cannot drift from the contract package without failing.
 *
 * The clock is anchored so every rendered clock label is the same on every run.
 * Hermes' `cron` entry deliberately has no `at`: pi's entries outside a run
 * window have no timestamp, and the transcript must render that as no time
 * rather than a substituted one.
 *
 * Hermes carries one parked task too: the harness blocked it after too many
 * restarts, and it is the one row the home offers a button for.
 */
export const FIXTURE_NOW = 1_792_145_100_000;

const at = (minutesAgo) => FIXTURE_NOW - minutesAgo * 60_000;

export const HERMES_STREAM = {
  stream: "feed:hermes:7",
  generation: 7,
  cursor: 412,
  state: "streaming",
};

export const SCRIBE_STREAM = {
  stream: "feed:scribe:5",
  generation: 5,
  cursor: 128,
  state: "completed",
};

export const HERMES_STATUS = {
  id: "hermes",
  model: { provider: "opencode-go", id: "deepseek-v4-pro" },
  thinkingLevel: "high",
  busy: true,
  pending: [{ operationId: "cron:hermes:2026-10-16T09:00", origin: "cron", status: "running" }],
  usage: { inputTokens: 12_400, outputTokens: 3_100, exchanges: 2 },
  approvals: [
    {
      approvalId: "apr_botmail_send",
      bot: "hermes",
      toolPath: "botmail.send",
      summary: "Send the drafted reply to arena@northwind.co about the Q3 renewal?",
      artifact: {
        label: "Draft to arena@northwind.co",
        body: [
          "Hi Dana,",
          "",
          "Thanks for the nudge. Two things before we sign.",
          "",
          "First, the renewal term stays at 12 months. Second, the start date moves to 1 August so it lines up with the new quarter.",
          "",
          "If that works I will send the paperwork today.",
          "",
          "Adam",
        ].join("\n"),
      },
      status: "pending",
      requestedAt: at(4),
    },
  ],
  activeStream: HERMES_STREAM,
  activeRun: {
    ordinal: 7,
    session: "1",
    inputs: ["Reconciling March invoices"],
    startedAt: at(6),
    stream: HERMES_STREAM,
  },
  failures: [
    {
      at: at(9),
      kind: "task_faulted",
      name: "TypeError",
      detail: "Cannot read properties of undefined (reading 'amount')",
    },
  ],
  tasks: [
    {
      id: "task_invoice_ledger",
      kind: "reconcile",
      session: "hermes",
      status: "running",
      phase: "matching March invoices against the ledger",
      background: true,
    },
    {
      id: "task_payroll_run",
      kind: "payroll",
      session: "hermes",
      status: "blocked",
      reason: "restart_limit",
      background: false,
    },
  ],
};

export const SCRIBE_STATUS = {
  id: "scribe",
  model: { provider: "opencode-go", id: "longcat-2.5-preview-free" },
  thinkingLevel: null,
  busy: false,
  pending: [],
  usage: { inputTokens: 1_080, outputTokens: 640, exchanges: 1 },
  approvals: [],
  activeStream: SCRIBE_STREAM,
};

export const STATUS_RESPONSE = {
  bots: { hermes: HERMES_STATUS, scribe: SCRIBE_STATUS },
  errors: {},
};

export const HERMES_TRANSCRIPT = {
  session: "hermes",
  stream: HERMES_STREAM,
  entries: [
    {
      id: 41,
      kind: "assistant",
      role: "assistant",
      text: "Three things moved overnight. The invoice thread is unblocked, Thursday's calendar holds, and Botmail needs you to confirm one send.",
      at: at(53),
      origin: "http",
    },
    {
      id: 42,
      kind: "user",
      role: "user",
      text: "confirm the send",
      at: at(51),
      origin: "http",
    },
    {
      id: 43,
      kind: "assistant",
      role: "assistant",
      text: "Hourly check-in. Nothing needs you except the Botmail send above. Scribe has the Q3 notes if you want them.",
      origin: "cron",
    },
    {
      id: 44,
      kind: "assistant",
      role: "assistant",
      text: "Calendar hold moved to Thursday 10:00.",
      at: at(24),
      origin: "http",
    },
  ],
};

export const SCRIBE_TRANSCRIPT = {
  session: "scribe",
  stream: SCRIBE_STREAM,
  entries: [
    {
      id: 88,
      kind: "user",
      role: "user",
      text: "Kickoff transcript is in the thread. What did we decide?",
      at: at(120),
      origin: "http",
    },
    {
      id: 89,
      kind: "assistant",
      role: "assistant",
      text: "Q3 kickoff thread, four decisions: ship the renewal flow first, hold pricing until Friday, Scribe owns the notes, Hermes owns the follow-ups.",
      at: at(115),
      origin: "http",
    },
    {
      id: 90,
      kind: "assistant",
      role: "assistant",
      text: "Q3 kickoff notes, 4 decisions",
      at: at(113),
      origin: "delegate",
    },
  ],
};

export const TRANSCRIPTS = {
  hermes: HERMES_TRANSCRIPT,
  scribe: SCRIBE_TRANSCRIPT,
};

/**
 * The roster the registry holds, in the shape `GET /bots` serves.
 *
 * Hermes carries the parts of a configuration the roster screen does not edit
 * — a delegate list, a run policy and the commitments flag — so a save that
 * touches only the prompt can be shown to leave them alone.
 *
 * Atlas runs on a Workers AI model, which the catalog does not list, so its
 * model has to stay visible in the picker anyway.
 */
export const ROSTER = {
  bots: {
    hermes: {
      model: "deepseek-v4-pro",
      thinkingLevel: "high",
      systemPrompt:
        "You are Hermes, my chief of staff. You keep track of my open commitments and priorities.",
      brief: "Hourly check-in. Advance anything you can do without me, and note what needs me.",
      delegatesTo: ["scribe"],
      runtime: { maxRetries: 3, parallelTools: true },
      commitments: true,
    },
    scribe: {
      model: "longcat-2.5-preview-free",
      systemPrompt:
        "You are Scribe, my note-taker. You capture what matters and turn it into short summaries.",
    },
    atlas: {
      model: "@cf/meta/llama-3-3-70b-instruct-fp8-fast",
      thinkingLevel: "low",
      systemPrompt: "You are Atlas. You read everything and say what it means.",
      brief: "Read the open threads and report what changed.",
    },
  },
};

/** The model catalog, in the shape `GET /models` serves. */
export const CATALOG = {
  models: {
    "claude-haiku-5-5": ["none", "low", "medium", "high", "xhigh", "max"],
    "deepseek-v4-pro": ["high", "max"],
    "glm-5.3": ["low", "high", "max"],
    "kimi-k2.7-code": [],
    "longcat-2.5-preview-free": [],
  },
};
