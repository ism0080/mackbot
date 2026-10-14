/**
 * DelegationPolicy — gatekeeper for bot-to-bot delegation.
 *
 * A bot with an explicit `delegatesTo` allowlist may only reach those targets.
 * A bot without one may reach any other declared bot (the v1 any→any default),
 * but never itself. The policy is built from the loaded roster so the rule
 * lives in one place instead of inline in the tool.
 */
import type { BotConfig } from "../bots.ts";

export interface DelegationPolicy {
  readonly canDelegate: (sourceBotId: string, targetBotId: string) => boolean;
  readonly allowedTargets: (sourceBotId: string) => readonly string[];
}

export const createDelegationPolicy = (
  bots: Readonly<Record<string, BotConfig>>,
): DelegationPolicy => {
  const allowedTargets = (sourceBotId: string): readonly string[] => {
    const source = bots[sourceBotId];
    if (source === undefined) return [];
    if (source.delegatesTo !== undefined) return source.delegatesTo;
    return Object.keys(bots).filter((id) => id !== sourceBotId);
  };
  return {
    allowedTargets,
    canDelegate: (sourceBotId, targetBotId) => allowedTargets(sourceBotId).includes(targetBotId),
  };
};
