// good-css, interaction.md "Press feedback": "Keep the scale between 0.95 and
// 0.98." The range is a condition of the technique, and it is only the press
// state that carries it, so the check is scoped to `:active` rules. Core
// stylelint cannot join a selector to the value it is meant to bound.

import stylelint from "stylelint";

import { functionArguments } from "./shared.mjs";

const { createPlugin } = stylelint;
const { report, ruleMessages, validateOptions } = stylelint.utils;

const ruleName = "mackbot/press-scale-in-range";

const messages = ruleMessages(ruleName, {
  rejected: (ratio) =>
    `Expected the press scale ${ratio} to be between 0.95 and 0.98`,
});

const MIN = 0.95;
const MAX = 0.98;

/**
 * Every scale ratio written by a declaration on a `:active` rule.
 *
 * @param {import('postcss').Declaration} decl
 * @returns {number[]}
 */
function scaleRatios(decl) {
  const property = decl.prop.toLowerCase();

  if (property === "transform") {
    return functionArguments(decl.value, "scale")
      .map((args) => Number.parseFloat(args.split(",")[0] ?? ""))
      .filter((ratio) => !Number.isNaN(ratio));
  }

  if (property === "scale") {
    const ratio = Number.parseFloat(decl.value.split(/\s+/u)[0] ?? "");
    return Number.isNaN(ratio) ? [] : [ratio];
  }

  return [];
}

/** @type {import('stylelint').Rule} */
const rule = () => (root, result) => {
  const validOptions = validateOptions(result, ruleName, {
    actual: true,
    possible: [true],
  });

  if (!validOptions) return;

  root.walkRules((ruleNode) => {
    if (!/:active\b/u.test(ruleNode.selector)) return;

    ruleNode.walkDecls((decl) => {
      for (const ratio of scaleRatios(decl)) {
        if (ratio >= MIN && ratio <= MAX) continue;

        report({
          message: messages.rejected,
          messageArgs: [String(ratio)],
          node: decl,
          result,
          ruleName,
        });
      }
    });
  });
};

rule.ruleName = ruleName;
rule.messages = messages;

export default createPlugin(ruleName, rule);
