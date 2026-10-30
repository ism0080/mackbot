import { botOf } from "../registry-store.ts";
import type { BotConfig } from "../bots.ts";

export interface DelegationPolicy {
  readonly canDelegate: (sourceBotId: string, targetBotId: string) => boolean;
  readonly allowedTargets: (sourceBotId: string) => readonly string[];
}

/**
 * Who a bot may hand work to. An absent `delegatesTo` means every other bot
 * and an empty one means none, as the roster documents it; the depth and
 * cycle limits on a chain of hand-offs live in `bot-delegation.ts`.
 */
export const createDelegationPolicy = (
  bots: Readonly<Record<string, BotConfig>>,
): DelegationPolicy => {
  const allowedTargets = (sourceBotId: string): readonly string[] => {
    const source = botOf(bots, sourceBotId);
    if (source === undefined) return [];
    if (source.delegatesTo !== undefined) return source.delegatesTo;
    return Object.keys(bots).filter((id) => id !== sourceBotId);
  };
  return {
    allowedTargets,
    canDelegate: (sourceBotId, targetBotId) => allowedTargets(sourceBotId).includes(targetBotId),
  };
};
