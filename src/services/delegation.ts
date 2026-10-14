/**
 * DelegationPolicy — gatekeeper for bot-to-bot delegation.
 */
export interface DelegationPolicy {
  readonly canDelegate: (sourceBotId: string, targetBotId: string) => boolean;
  readonly allowedTargets?: (sourceBotId: string) => readonly string[];
}
