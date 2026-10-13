import { noArrayFilterMapRule } from "./rules/anti-slop/no-array-filter-map.ts";
import { noChainedTypeAssertionsRule } from "./rules/anti-slop/no-chained-type-assertions.ts";
import { noConditionalEmptyObjectSpreadRule } from "./rules/anti-slop/no-conditional-empty-object-spread.ts";
import { noKnownValueWideningRule } from "./rules/anti-slop/no-known-value-widening.ts";
import { noModuleMockingRule } from "./rules/anti-slop/no-module-mocking.ts";
import { noObjectParametersRule } from "./rules/anti-slop/no-object-parameters.ts";
import { noReduceAccumulatorCopyRule } from "./rules/anti-slop/no-reduce-accumulator-copy.ts";
import { noReflectApplyRule } from "./rules/anti-slop/no-reflect-apply.ts";
import { noReflectGetRule } from "./rules/anti-slop/no-reflect-get.ts";
import { noRuntimeTypeofRule } from "./rules/anti-slop/no-runtime-typeof.ts";
import { noForbiddenTermInSymbolNamesRule as noShapeInSymbolNamesRule } from "./rules/anti-slop/no-shape-in-symbol-names.ts";
import { noUnknownParametersRule } from "./rules/anti-slop/no-unknown-parameters.ts";
import { noUnknownReturnsRule } from "./rules/anti-slop/no-unknown-returns.ts";
import { noUnknownTypeAliasesRule } from "./rules/anti-slop/no-unknown-type-aliases.ts";
import { noUnsafeDictionaryTypeRule } from "./rules/anti-slop/no-unsafe-dictionary-type.ts";
import { noWidenThenAssertRule } from "./rules/anti-slop/no-widen-then-assert.ts";
import { requireSafetyCommentForTypeAssertionRule } from "./rules/anti-slop/require-safety-comment-for-type-assertion.ts";
import noAmbientNondeterminismRule from "./rules/effect/no-ambient-nondeterminism.ts";
import noCascadingLayerProvideRule from "./rules/effect/no-cascading-layer-provide.ts";
import noDirectBrowserStorageRule from "./rules/effect/no-direct-browser-storage.ts";
import noDirectFetchRule from "./rules/effect/no-direct-fetch.ts";
import noDisableValidationRule from "./rules/effect/no-disable-validation.ts";
import noEffectAsVoidRule from "./rules/effect/no-effect-as-void.ts";
import noGlobalJsonRule from "./rules/effect/no-global-json.ts";
import noInOperatorRule from "./rules/effect/no-in-operator.ts";
import noNestedEffectArrayMethodsRule from "./rules/effect/no-nested-effect-array-methods.ts";
import noNestedLayerProvideRule from "./rules/effect/no-nested-layer-provide.ts";
import { noServiceConstructorImportsRule } from "./rules/effect/no-service-constructor-imports.ts";
import noServiceOptionRule from "./rules/effect/no-service-option.ts";
import noShadowedStandardArrayStaticRule from "./rules/effect/no-shadowed-standard-array-static.ts";
import noSilentErrorSwallowRule from "./rules/effect/no-silent-error-swallow.ts";
import noStaticEffectServiceForwardersRule from "./rules/effect/no-static-effect-service-forwarders.ts";
import noSwitchRule from "./rules/effect/no-switch.ts";
import noTryCatchRule from "./rules/effect/no-try-catch.ts";
import pipeMaxArgumentsRule from "./rules/effect/pipe-max-arguments.ts";
import { preferEffectMatchRule } from "./rules/effect/prefer-effect-match.ts";
import preferOptionFromNullableRule from "./rules/effect/prefer-option-from-nullable.ts";
import noFixedHeightOnContentRule from "./rules/react/no-fixed-height-on-content.ts";
import noDirectXstateCreateMachineRule from "./rules/xstate/no-direct-xstate-create-machine.ts";
import noDirectXstateUseSelectorRule from "./rules/xstate/no-direct-xstate-use-selector.ts";
import noMultipleXstateHooksRule from "./rules/xstate/no-multiple-xstate-hooks.ts";
import noReactStateHooksRule from "./rules/xstate/no-react-state-hooks.ts";
import noSingleUseXstateActionsRule from "./rules/xstate/no-single-use-xstate-actions.ts";
import noSingleUseXstateGuardsRule from "./rules/xstate/no-single-use-xstate-guards.ts";
import requireXstateEventSatisfiesRule from "./rules/xstate/require-xstate-event-satisfies.ts";
import { noManualEffectErrorTagRule } from "./rules/effect/no-manual-effect-error-tag.ts";
import { noManualTagComparisonRule } from "./rules/effect/no-manual-tag-comparison.ts";
import { noManualTaggedConstructionRule } from "./rules/effect/no-manual-tagged-construction.ts";

import type { Rule } from "@oxlint/plugins";
import type { RuleProfile, RuleSeverity } from "./config.ts";

export interface RuleDefinition {
  readonly rule: Rule;
  readonly profile: RuleProfile;
  readonly severity: RuleSeverity;
}

const defineRuleRegistry = <
  const Registry extends Record<string, RuleDefinition>,
>(
  registry: Registry,
): Readonly<Registry> => Object.freeze(registry);

export const ruleDefinitions = defineRuleRegistry({
  //
  // Core
  //
  "no-array-filter-map": {
    rule: noArrayFilterMapRule,
    profile: "core",
    severity: "error",
  },
  "no-chained-type-assertions": {
    rule: noChainedTypeAssertionsRule,
    profile: "core",
    severity: "error",
  },
  "no-conditional-empty-object-spread": {
    rule: noConditionalEmptyObjectSpreadRule,
    profile: "core",
    severity: "error",
  },
  "no-known-value-widening": {
    rule: noKnownValueWideningRule,
    profile: "core",
    severity: "error",
  },
  "no-module-mocking": {
    rule: noModuleMockingRule,
    profile: "core",
    severity: "error",
  },
  "no-object-parameters": {
    rule: noObjectParametersRule,
    profile: "core",
    severity: "error",
  },
  "no-reduce-accumulator-copy": {
    rule: noReduceAccumulatorCopyRule,
    profile: "core",
    severity: "error",
  },
  "no-reflect-apply": {
    rule: noReflectApplyRule,
    profile: "core",
    severity: "error",
  },
  "no-reflect-get": {
    rule: noReflectGetRule,
    profile: "core",
    severity: "error",
  },
  "no-runtime-typeof": {
    rule: noRuntimeTypeofRule,
    profile: "core",
    severity: "error",
  },
  "no-shape-in-symbol-names": {
    rule: noShapeInSymbolNamesRule,
    profile: "core",
    severity: "error",
  },
  "no-unknown-parameters": {
    rule: noUnknownParametersRule,
    profile: "core",
    severity: "error",
  },
  "no-unknown-returns": {
    rule: noUnknownReturnsRule,
    profile: "core",
    severity: "error",
  },
  "no-unknown-type-aliases": {
    rule: noUnknownTypeAliasesRule,
    profile: "core",
    severity: "error",
  },
  "no-unsafe-dictionary-type": {
    rule: noUnsafeDictionaryTypeRule,
    profile: "core",
    severity: "error",
  },
  "no-widen-then-assert": {
    rule: noWidenThenAssertRule,
    profile: "core",
    severity: "error",
  },
  "require-safety-comment-for-type-assertion": {
    rule: requireSafetyCommentForTypeAssertionRule,
    profile: "core",
    severity: "error",
  },
  //
  // Effect
  //
  "no-ambient-nondeterminism": {
    rule: noAmbientNondeterminismRule,
    profile: "effect",
    severity: "error",
  },
  "no-cascading-layer-provide": {
    rule: noCascadingLayerProvideRule,
    profile: "effect",
    severity: "error",
  },
  "no-direct-browser-storage": {
    rule: noDirectBrowserStorageRule,
    profile: "effect",
    severity: "error",
  },
  "no-direct-fetch": {
    rule: noDirectFetchRule,
    profile: "effect",
    severity: "error",
  },
  "no-disable-validation": {
    rule: noDisableValidationRule,
    profile: "effect",
    severity: "error",
  },
  "no-effect-as-void": {
    rule: noEffectAsVoidRule,
    profile: "effect",
    severity: "error",
  },
  "no-global-json": {
    rule: noGlobalJsonRule,
    profile: "effect",
    severity: "error",
  },
  "no-in-operator": {
    rule: noInOperatorRule,
    profile: "effect",
    severity: "error",
  },
  "no-nested-effect-array-methods": {
    rule: noNestedEffectArrayMethodsRule,
    profile: "effect",
    severity: "error",
  },
  "no-nested-layer-provide": {
    rule: noNestedLayerProvideRule,
    profile: "effect",
    severity: "error",
  },
  "no-service-constructor-imports": {
    rule: noServiceConstructorImportsRule,
    profile: "effect",
    severity: "error",
  },
  "no-service-option": {
    rule: noServiceOptionRule,
    profile: "effect",
    severity: "error",
  },
  "no-shadowed-standard-array-static": {
    rule: noShadowedStandardArrayStaticRule,
    profile: "effect",
    severity: "error",
  },
  "no-silent-error-swallow": {
    rule: noSilentErrorSwallowRule,
    profile: "effect",
    severity: "error",
  },
  "no-static-effect-service-forwarders": {
    rule: noStaticEffectServiceForwardersRule,
    profile: "effect",
    severity: "error",
  },
  "no-switch": { rule: noSwitchRule, profile: "effect", severity: "error" },
  "no-try-catch": {
    rule: noTryCatchRule,
    profile: "effect",
    severity: "error",
  },
  "pipe-max-arguments": {
    rule: pipeMaxArgumentsRule,
    profile: "effect",
    severity: "error",
  },
  "prefer-effect-match": {
    rule: preferEffectMatchRule,
    profile: "effect",
    severity: "error",
  },
  "prefer-option-from-nullable": {
    rule: preferOptionFromNullableRule,
    profile: "effect",
    severity: "error",
  },
  "no-manual-effect-error-tag": {
    rule: noManualEffectErrorTagRule,
    profile: "effect",
    severity: "error",
  },
  "no-manual-tag-comparison": {
    rule: noManualTagComparisonRule,
    profile: "effect",
    severity: "error",
  },
  "no-manual-tagged-construction": {
    rule: noManualTaggedConstructionRule,
    profile: "effect",
    severity: "error",
  },
  //
  // React
  //
  "no-fixed-height-on-content": {
    rule: noFixedHeightOnContentRule,
    profile: "react",
    severity: "error",
  },
  //
  // XState
  //
  "no-direct-xstate-create-machine": {
    rule: noDirectXstateCreateMachineRule,
    profile: "xstate",
    severity: "error",
  },
  "no-direct-xstate-use-selector": {
    rule: noDirectXstateUseSelectorRule,
    profile: "xstate",
    severity: "error",
  },
  "no-multiple-xstate-hooks": {
    rule: noMultipleXstateHooksRule,
    profile: "xstate",
    severity: "error",
  },
  "no-react-state-hooks": {
    rule: noReactStateHooksRule,
    profile: "xstate",
    severity: "error",
  },
  "no-single-use-xstate-actions": {
    rule: noSingleUseXstateActionsRule,
    profile: "xstate",
    severity: "error",
  },
  "no-single-use-xstate-guards": {
    rule: noSingleUseXstateGuardsRule,
    profile: "xstate",
    severity: "error",
  },
  "require-xstate-event-satisfies": {
    rule: requireXstateEventSatisfiesRule,
    profile: "xstate",
    severity: "error",
  },
});

export type ForgeRuleName = keyof typeof ruleDefinitions;
