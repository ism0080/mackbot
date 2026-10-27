// Every `:hover` rule must sit inside `@media (hover: hover) and (pointer:
// fine)`, so a tap on a touch screen does not leave the hover state stuck.
//
// Core stylelint matches one selector at a time and cannot see the @media that
// wraps it, so the nesting context has to be checked here.

import stylelint from "stylelint";

import { isInsideMedia } from "./shared.mjs";

const { createPlugin } = stylelint;
const { report, ruleMessages, validateOptions } = stylelint.utils;

const ruleName = "mackbot/hover-in-hover-media";

const messages = ruleMessages(ruleName, {
  rejected: (selector) =>
    `Expected the ":hover" rule "${selector}" to be inside @media (hover: hover) and (pointer: fine)`,
});

/** @type {import('stylelint').Rule} */
const rule = () => (root, result) => {
  const validOptions = validateOptions(result, ruleName, {
    actual: true,
    possible: [true],
  });

  if (!validOptions) return;

  root.walkRules((ruleNode) => {
    if (!/:hover\b/u.test(ruleNode.selector)) return;
    if (isInsideMedia(ruleNode, "(hover:hover)", "(pointer:fine)")) return;

    report({
      message: messages.rejected,
      messageArgs: [ruleNode.selector],
      node: ruleNode,
      result,
      ruleName,
    });
  });
};

rule.ruleName = ruleName;
rule.messages = messages;

export default createPlugin(ruleName, rule);
