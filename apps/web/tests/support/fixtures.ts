/**
 * Fixtures for the browser app's Story and Scene tests.
 *
 * The values are decoded with the same Schemas the app uses, so a fixture that
 * drifts from the contract fails in the test rather than rendering a shape the
 * server would never send. `FIXTURE_NOW` pins the clock: update mints `now`
 * from `/status`, and the views turn it into relative labels, so an unpinned
 * clock would make an assertion about "4m" fail a minute later.
 */
import type {
  ApprovalView,
  BotConfig,
  BotView,
  EntryView,
  Frame,
  ModelCatalog,
  Roster,
  TranscriptPage,
} from "@mackbot/contract";
import { BotViewSchema, RosterSchema, TranscriptPageSchema } from "@mackbot/contract";
import { AsyncData } from "foldkit";
import * as Schema from "effect/Schema";

import { init } from "../../src/main.ts";
import type { Model } from "../../src/model.ts";

export const FIXTURE_NOW = 1_792_145_100_000;

const at = (minutesAgo: number): number => FIXTURE_NOW - minutesAgo * 60_000;

const stream = (session: string, generation: number, cursor = 0) => ({
  stream: `feed:${session}:${generation}`,
  generation,
  cursor,
  state: "streaming" as const,
});

export const approvalOf = (overrides: Partial<ApprovalView> = {}): ApprovalView => ({
  approvalId: "apr_send",
  bot: "hermes",
  toolPath: "botmail.send",
  summary: "Send the drafted reply to arena@northwind.co?",
  status: "pending",
  requestedAt: at(4),
  ...overrides,
});

export const statusOf = (overrides: Partial<BotView> = {}): BotView => {
  const candidate = {
    id: "hermes",
    model: { provider: "opencode-go", id: "deepseek-v4-pro" },
    thinkingLevel: "high",
    busy: false,
    pending: [],
    usage: { inputTokens: 1_200, outputTokens: 300, exchanges: 1 },
    approvals: [],
    activeStream: stream("hermes", 3),
    ...overrides,
  } satisfies BotView;

  return Schema.decodeUnknownSync(BotViewSchema)(candidate);
};

export const entryOf = (overrides: Partial<EntryView> = {}): EntryView => ({
  id: 1,
  kind: "message",
  role: "assistant",
  text: "Three things moved overnight.",
  at: at(5),
  origin: "http",
  ...overrides,
});

export const transcriptOf = (overrides: Partial<TranscriptPage> = {}): TranscriptPage => {
  const candidate = {
    session: "hermes",
    entries: [entryOf()],
    stream: stream("hermes", 3, 12),
    ...overrides,
  } satisfies TranscriptPage;

  return Schema.decodeUnknownSync(TranscriptPageSchema)(candidate);
};

export const botConfigOf = (overrides: Partial<BotConfig> = {}): BotConfig => ({
  model: "deepseek-v4-pro",
  systemPrompt: "You are Hermes, my chief of staff.",
  ...overrides,
});

export const rosterOf = (bots: Record<string, BotConfig> = {}): Roster =>
  Schema.decodeUnknownSync(RosterSchema)({
    bots: {
      hermes: botConfigOf({
        brief: "Hourly check-in.",
        delegatesTo: ["scribe"],
        runtime: { maxRetries: 3, parallelTools: true },
        commitments: true,
      }),
      scribe: botConfigOf({
        model: "longcat-2.5-preview-free",
        systemPrompt: "You are Scribe, my note-taker.",
      }),
      ...bots,
    },
  });

export const CATALOG: ModelCatalog = {
  models: {
    "deepseek-v4-pro": ["high", "max"],
    "claude-haiku-5-5": ["none", "low", "medium", "high", "xhigh", "max"],
    "longcat-2.5-preview-free": [],
  },
};

export const frameOf = (frame: Frame, seq: number | undefined, bot = "hermes") => ({
  bot,
  frame,
  seq,
});

/** The Model every story starts from: the app's real `init`, with the URL's screen. */
export const modelWith = (overrides: Partial<Model> = {}): Model => ({
  ...init().model,
  ...overrides,
});

/** A transcript screen with one bot's channel already seeded. */
export const transcriptModel = (
  bot: string,
  channel: Partial<Model["channels"][string]> = {},
): Model => {
  const base = modelWith();
  return {
    ...base,
    channels: {
      ...base.channels,
      [bot]: {
        status: AsyncData.Idle(),
        threads: AsyncData.Idle(),
        archived: AsyncData.Idle(),
        transcript: AsyncData.Idle(),
        stream: { phase: "idle", generation: 0, lastSeq: 0, attempt: 0, failures: 0 },
        frames: [],
        draft: "",
        sending: false,
        refreshing: false,
        loadingEarlier: false,
        pending: [],
        ...channel,
      },
    },
  };
};
