// A transition or animation that moves or scales must sit inside
// `@media (prefers-reduced-motion: no-preference)`.
//
// Core stylelint cannot see the @media that wraps a declaration, so this rule
// checks the ancestor chain. A transition moves or scales when it names
// transform/translate/scale/rotate; an animation does when one of the
// @keyframes it names declares one of those properties.

import stylelint from "stylelint";

import { isInsideMedia, splitTopLevel } from "./shared.mjs";

const { createPlugin } = stylelint;
const { report, ruleMessages, validateOptions } = stylelint.utils;

const ruleName = "mackbot/motion-in-reduced-motion-media";

const messages = ruleMessages(ruleName, {
  rejected: (property) =>
    `Expected the moving/animated "${property}" declaration to be inside @media (prefers-reduced-motion: no-preference)`,
});

// `translateX`, `scale3d` and `rotateZ` are the same move as their long form,
// so the trailing boundary is intentionally loose.
const MOVING = /\b(?:transform|translate|scale|rotate)/iu;
const REDUCED_MOTION = "(prefers-reduced-motion:no-preference)";

// Shorthand words that are not animation names.
const ANIMATION_KEYWORDS = new Set([
  "none",
  "linear",
  "ease",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "step-start",
  "step-end",
  "infinite",
  "normal",
  "reverse",
  "alternate",
  "alternate-reverse",
  "forwards",
  "backwards",
  "both",
  "running",
  "paused",
  "auto",
]);

/**
 * Names an `animation` or `animation-name` value refers to.
 *
 * @param {string} value
 */
function animationNames(value) {
  return splitTopLevel(value).flatMap((group) =>
    group
      .split(/\s+/u)
      .filter((token) => /^[A-Za-z_-][\w-]*$/u.test(token))
      .filter((token) => !ANIMATION_KEYWORDS.has(token.toLowerCase())),
  );
}

/**
 * True when a named @keyframes declares a moving or scaling property.
 *
 * @param {import('postcss').Root} root
 * @param {string} name
 */
function keyframesMove(root, name) {
  let moving = false;

  root.walkAtRules(/^(?:-\w+-)?keyframes$/iu, (atRule) => {
    if (atRule.params.trim().toLowerCase() !== name.toLowerCase()) return;
    atRule.walkDecls((decl) => {
      if (MOVING.test(decl.value)) moving = true;
    });
  });

  return moving;
}

/**
 * @param {import('postcss').Declaration} decl
 * @returns {boolean}
 */
function movesOrScales(decl, root) {
  const property = decl.prop.toLowerCase();
  const value = decl.value;

  if (property === "transition" || property === "transition-property") {
    return MOVING.test(value);
  }

  if (property === "animation" || property === "animation-name") {
    return animationNames(value).some((name) => keyframesMove(root, name));
  }

  return false;
}

/** @type {import('stylelint').Rule} */
const rule = () => (root, result) => {
  const validOptions = validateOptions(result, ruleName, {
    actual: true,
    possible: [true],
  });

  if (!validOptions) return;

  root.walkDecls((decl) => {
    if (!movesOrScales(decl, root)) return;
    if (isInsideMedia(decl, REDUCED_MOTION)) return;

    report({
      message: messages.rejected,
      messageArgs: [decl.prop],
      node: decl,
      result,
      ruleName,
    });
  });
};

rule.ruleName = ruleName;
rule.messages = messages;

export default createPlugin(ruleName, rule);
