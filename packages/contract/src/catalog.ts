/**
 * catalog — the models mackbot knows, and the thinking levels they support.
 *
 * This is the source of the `ThinkingLevel` union: a level is valid if some
 * model in the catalog supports it. The wire contract mirrors that union and
 * proves the two agree at compile time (see `src/index.ts`), so a level added
 * here without a wire counterpart fails the build rather than shipping.
 *
 * The catalog lives in the contract package because the wire enum derives from
 * it. The browser imports the wire enum, never this file, so the model catalog
 * never reaches the browser's module graph.
 */

export const MODEL_VARIANTS = {
  "deepseek-v4-pro": ["high", "max"],
  "deepseek-v4.1-flash": ["low", "high", "max"],
  "deepseek-v4-flash": ["low", "high", "max"],
  "glm-5.3": ["low", "high", "max"],
  "glm-5.3-flash": ["low", "high", "max"],
  "kimi-k2.7-code": [],
  "claude-haiku-5-5": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
  "longcat-2.5-preview-free": [],
  "step-5-preview-free": ["low", "medium", "high"],
} as const;

export type ThinkingLevel = (typeof MODEL_VARIANTS)[keyof typeof MODEL_VARIANTS][number];
