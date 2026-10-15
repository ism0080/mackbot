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
