export const NAMESPACE = "forge" as const;

export type RuleProfile = "core" | "effect" | "react" | "xstate";
export type RuleSeverity = "error" | "warn" | "off";
