import { definePlugin } from "@oxlint/plugins";
import { ruleDefinitions } from "./registry.ts";

const rules = Object.fromEntries(
  Object.entries(ruleDefinitions).map(([name, definition]) => [name, definition.rule]),
);

const plugin = definePlugin({
  meta: { name: "forge" },
  rules,
});

export default plugin;
export { allRules, profile, profiles } from "./profiles.ts";
export { oxlintRuleMetadata, rulesByProfile, severityByRule } from "./catalog.ts";
export { ruleDefinitions, type ForgeRuleName, type RuleDefinition } from "./registry.ts";
export { NAMESPACE, type RuleProfile, type RuleSeverity } from "./config.ts";
