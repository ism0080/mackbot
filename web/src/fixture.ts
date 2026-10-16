import * as Schema from "effect/Schema";
import { Channel } from "./model.ts";

/**
 * The fixture clock. Relative labels ("waiting 4m") need a "now", and a fixture
 * that read the wall clock would render differently on every open, so the whole
 * fixture is anchored here. The unit that wires `/status` replaces it with the
 * client's own clock.
 */
export const FIXTURE_NOW = 1_792_145_100_000;

const at = (minutesAgo: number): number => FIXTURE_NOW - minutesAgo * 60_000;

const hermesStream = {
  stream: "feed:hermes:7",
  generation: 7,
  cursor: 412,
  state: "streaming",
} as const;

const scribeStream = {
  stream: "feed:scribe:5",
  generation: 5,
  cursor: 128,
  state: "completed",
} as const;

/**
 * Two bots, shaped exactly as `GET /status` and `GET /transcript/:bot` will
 * return them, so the routes replace this module rather than rewriting it. Bot
 * names and models are the ones in `bots.json`.
 */
const Fixture = Schema.Struct({
  channels: Schema.Record(Schema.String, Channel),
});

export const FIXTURE_CHANNELS = Schema.decodeUnknownSync(Fixture)({
  channels: {
    hermes: {
      status: {
        _tag: "Success",
        data: {
          id: "hermes",
          model: { provider: "opencode-go", id: "deepseek-v4-pro" },
          thinkingLevel: "high",
          busy: true,
          pending: [
            {
              operationId: "cron:hermes:2026-10-16T09:00",
              origin: "cron",
              status: "running",
            },
          ],
          usage: { inputTokens: 12_400, outputTokens: 3_100, exchanges: 2 },
          approvals: [
            {
              approvalId: "apr_botmail_send",
              bot: "hermes",
              toolPath: "botmail.send",
              summary:
                "Send the drafted reply to arena@northwind.co about the Q3 renewal?",
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
          activeStream: hermesStream,
          activeRun: {
            ordinal: 7,
            inputs: ["Reconciling March invoices"],
            startedAt: at(6),
            stream: hermesStream,
          },
        },
      },
      transcript: {
        _tag: "Success",
        data: {
          session: "hermes",
          stream: hermesStream,
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
              at: at(35),
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
        },
      },
    },
    scribe: {
      status: {
        _tag: "Success",
        data: {
          id: "scribe",
          model: { provider: "opencode-go", id: "longcat-2.5-preview-free" },
          thinkingLevel: null,
          busy: false,
          pending: [],
          usage: { inputTokens: 1_080, outputTokens: 640, exchanges: 1 },
          approvals: [],
          activeStream: scribeStream,
        },
      },
      transcript: {
        _tag: "Success",
        data: {
          session: "scribe",
          stream: scribeStream,
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
        },
      },
    },
  },
}).channels;
