import { oxlintRuleMetadata, rulesByProfile, severityByRule } from "./catalog.ts";
import { NAMESPACE, type RuleProfile, type RuleSeverity } from "./config.ts";

export const profile = (
  name: RuleProfile,
  namespace: string = NAMESPACE,
): Readonly<Record<string, RuleSeverity>> =>
  Object.fromEntries(
    rulesByProfile[name].map((ruleName) => [
      `${namespace}/${ruleName}`,
      severityByRule[ruleName] ?? "error",
    ]),
  );

export const profiles = Object.freeze({
  core: profile("core"),
  effect: profile("effect"),
  react: profile("react"),
  xstate: profile("xstate"),
});

export const allRules = Object.freeze(
  Object.fromEntries(
    oxlintRuleMetadata.map(({ name, severity }) => [`${NAMESPACE}/${name}`, severity]),
  ),
);
