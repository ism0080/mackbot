import { describe, expect, it } from "vitest";

import plugin, {
  allRules,
  oxlintRuleMetadata,
  profile,
  profiles,
  ruleDefinitions,
  rulesByProfile,
} from "../index.ts";

describe("Oxlint rule registry", () => {
  it("derives plugin rules and metadata from every definition", () => {
    const ruleNames = Object.keys(ruleDefinitions);

    expect(Object.keys(plugin.rules)).toEqual(ruleNames);
    expect(oxlintRuleMetadata.map(({ name }) => name)).toEqual(ruleNames);
    expect(Object.keys(allRules)).toHaveLength(ruleNames.length);
    expect(Object.values(rulesByProfile).flat()).toHaveLength(ruleNames.length);
  });

  it("assigns every rule to exactly one public profile", () => {
    const profileRuleNames = Object.values(rulesByProfile).flat();

    expect(new Set(profileRuleNames).size).toBe(profileRuleNames.length);
    expect([...profileRuleNames].sort()).toEqual(Object.keys(ruleDefinitions).sort());
  });

  it("preserves severities when the plugin namespace is aliased", () => {
    for (const profileName of Object.keys(profiles) as Array<keyof typeof profiles>) {
      const aliasedRules = profile(profileName, "company");

      expect(Object.keys(aliasedRules).every((name) => name.startsWith("company/"))).toBe(true);
      expect(Object.values(aliasedRules)).toEqual(Object.values(profiles[profileName]));
    }
  });

  it("derives catalog descriptions and configurability from rule metadata", () => {
    expect(oxlintRuleMetadata.every(({ description }) => description.length > 0)).toBe(true);
    expect(
      oxlintRuleMetadata.find(({ name }) => name === "no-runtime-typeof")?.configurable,
    ).toBe(true);
    expect(oxlintRuleMetadata.find(({ name }) => name === "no-direct-fetch")?.configurable).toBe(
      false,
    );
  });
});
