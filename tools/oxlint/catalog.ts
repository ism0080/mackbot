import type { RuleProfile, RuleSeverity } from "./config.ts";
import { ruleDefinitions } from "./registry.ts";

export interface OxlintRuleMetadata {
  readonly name: string;
  readonly profile: RuleProfile;
  readonly severity: RuleSeverity;
  readonly applicability: string;
  readonly description: string;
  readonly configurable: boolean;
}

const profileApplicability: Readonly<Record<RuleProfile, string>> = {
  core: "TypeScript",
  effect: "Effect",
  react: "React",
  xstate: "XState",
};

export const oxlintRuleMetadata: ReadonlyArray<OxlintRuleMetadata> = Object.entries(
  ruleDefinitions,
).map(([name, definition]) => {
  const schema = definition.rule.meta?.schema;

  return {
    name,
    profile: definition.profile,
    severity: definition.severity,
    applicability: profileApplicability[definition.profile],
    description: definition.rule.meta?.docs?.description ?? "",
    configurable: Array.isArray(schema) && schema.length > 0,
  };
});

export const rulesByProfile: Readonly<Record<RuleProfile, ReadonlyArray<string>>> = {
  core: oxlintRuleMetadata.filter(({ profile }) => profile === "core").map(({ name }) => name),
  effect: oxlintRuleMetadata.filter(({ profile }) => profile === "effect").map(({ name }) => name),
  react: oxlintRuleMetadata.filter(({ profile }) => profile === "react").map(({ name }) => name),
  xstate: oxlintRuleMetadata.filter(({ profile }) => profile === "xstate").map(({ name }) => name),
};

export const severityByRule: Readonly<Record<string, RuleSeverity>> = Object.fromEntries(
  oxlintRuleMetadata.map(({ name, severity }) => [name, severity]),
);
