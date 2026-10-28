/**
 * Fixtures shared by the contract tests.
 *
 * These build pi's own records (`EntryRecord`, `Message`) from the smallest
 * realistic value, so a projection test exercises the real shapes rather than a
 * hand-rolled approximation of them. Factories return a fresh object on every
 * call, so tests never share mutable state.
 */

import type { Message } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  SystemMessage,
  TextContent,
  ThinkingContent,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";

/** A fixed wall clock, so a fixture that carries a timestamp stays deterministic. */
export const TIMESTAMP = 1_764_000_000_000;

export const textBlock = (text: string): TextContent => ({ type: "text", text });

export const thinkingBlock = (thinking: string): ThinkingContent => ({
  type: "thinking",
  thinking,
});

const ZERO_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const userMessage = (content: UserMessage["content"]): UserMessage => ({
  role: "user",
  content,
  timestamp: TIMESTAMP,
});

export const systemMessage = (content: SystemMessage["content"]): SystemMessage => ({
  role: "system",
  content,
  timestamp: TIMESTAMP,
});

export const assistantMessage = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "opencode-go",
  model: "deepseek-v4-pro",
  usage: ZERO_USAGE,
  stopReason: "stop",
  timestamp: TIMESTAMP,
});

export const toolResultMessage = (input: {
  readonly toolName: string;
  readonly content: ToolResultMessage["content"];
  readonly isError?: boolean;
  readonly toolCallId?: string;
}): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: input.toolCallId ?? `call_${input.toolName}`,
  toolName: input.toolName,
  content: input.content,
  isError: input.isError ?? false,
  timestamp: TIMESTAMP,
});

export interface EntryInput {
  readonly id: number;
  readonly kind: string;
  readonly model?: readonly Message[];
  readonly data?: EntryRecord["data"];
}

/**
 * One committed entry as pi stores it. The id is branded at the type level but
 * is a plain number at runtime, which is what the projections read.
 */
interface StoredEntry {
  id: number;
  conversationId: number;
  kind: string;
  model?: EntryInput["model"];
  data?: EntryInput["data"];
}

export const entryRecord = (input: EntryInput): EntryRecord => {
  const record: StoredEntry = { id: input.id, conversationId: 1, kind: input.kind };
  if (input.model !== undefined) record.model = input.model;
  if (input.data !== undefined) record.data = input.data;
  // SAFETY: `EntryRecord.id` is a branded number and the remaining fields are
  // optional at runtime; the projections under test read only these fields.
  return record as EntryRecord;
};
