// good-css, foundations.md "Fluid sizes with clamp()":
// - "Write the preferred value as `rem + vw`, never `vw` alone. ... A bare
//   `vw` value also ignores the reader's font size setting."
// - "Keep both bounds in `rem` so they follow the reader's font size."
//
// Both conditions are about the three arguments of one clamp() call, which a
// core stylelint rule cannot see as a unit.

import stylelint from "stylelint";

import { functionArguments, splitTopLevel } from "./shared.mjs";

const { createPlugin } = stylelint;
const { report, ruleMessages, validateOptions } = stylelint.utils;

const ruleName = "mackbot/fluid-clamp";

const messages = ruleMessages(ruleName, {
  bareViewport: (value) =>
    `Expected the clamp() preferred value "${value}" to pair a viewport unit with a font-relative one, never a viewport unit alone`,
  remBound: (value) =>
    `Expected the clamp() bound "${value}" to be in rem so it follows the reader's font size`,
});

const BARE_VIEWPORT =
  /^[-+.\d]+(?:vw|vh|vmin|vmax|vi|vb|dvw|dvh|dvmin|dvmax|dvi|dvb|svw|svh|svmin|svmax|svi|svb|lvw|lvh|lvmin|lvmax|lvi|lvb)$/iu;

/**
 * A zero length or a length written in rem.
 *
 * @param {string} value
 */
function isRemBound(value) {
  return /^0[a-z%]*$/iu.test(value) || /(?:^|[^a-z])rem(?![a-z])/iu.test(value);
}

/** @type {import('stylelint').Rule} */
const rule = () => (root, result) => {
  const validOptions = validateOptions(result, ruleName, {
    actual: true,
    possible: [true],
  });

  if (!validOptions) return;

  root.walkDecls((decl) => {
    for (const args of functionArguments(decl.value, "clamp")) {
      const parts = splitTopLevel(args);
      if (parts.length !== 3) continue;

      const [min, preferred, max] = parts;

      for (const bound of [min, max]) {
        if (isRemBound(bound)) continue;

        report({
          message: messages.remBound,
          messageArgs: [bound],
          node: decl,
          result,
          ruleName,
        });
      }

      if (BARE_VIEWPORT.test(preferred)) {
        report({
          message: messages.bareViewport,
          messageArgs: [preferred],
          node: decl,
          result,
          ruleName,
        });
      }
    }
  });
};

rule.ruleName = ruleName;
rule.messages = messages;

export default createPlugin(ruleName, rule);
