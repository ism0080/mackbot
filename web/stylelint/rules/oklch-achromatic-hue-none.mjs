// good-css, foundations.md "OKLCH color": "Write grays, white and black with
// `none` as the hue... A written hue of `0` is red, and it pulls every mix
// toward red." A zero-chroma color written with hue `0` looks identical on its
// own, so stylesheets accept the mistake silently and only the mix drifts, a
// colour bug no browser reports. Core stylelint has no rule for it.

import stylelint from "stylelint";

import { functionArguments } from "./shared.mjs";

const { createPlugin } = stylelint;
const { report, ruleMessages, validateOptions } = stylelint.utils;

const ruleName = "mackbot/oklch-achromatic-hue-none";

const messages = ruleMessages(ruleName, {
  rejected: (color) =>
    `Expected the achromatic ${color} to carry "none" as its hue, not a written 0`,
});

/**
 * Whether an oklch() call has zero chroma but a written hue of 0.
 *
 * @param {string} args the text between oklch( and )
 */
function isAchromaticZeroHue(args) {
  // Relative color syntax (`oklch(from ...)`) has a different shape.
  if (/^from\b/iu.test(args.trim())) return false;

  const [color] = args.split("/");
  const tokens = color.trim().split(/\s+/u);

  if (tokens.length < 3) return false;

  const chroma = Number.parseFloat(tokens[1]);
  if (Number.isNaN(chroma) || chroma !== 0) return false;

  const hue = Number.parseFloat(tokens[2]);
  return !Number.isNaN(hue) && hue === 0;
}

/** @type {import('stylelint').Rule} */
const rule = () => (root, result) => {
  const validOptions = validateOptions(result, ruleName, {
    actual: true,
    possible: [true],
  });

  if (!validOptions) return;

  root.walkDecls((decl) => {
    for (const args of functionArguments(decl.value, "oklch")) {
      if (!isAchromaticZeroHue(args)) continue;

      report({
        message: messages.rejected,
        messageArgs: [`oklch(${args.trim()})`],
        node: decl,
        result,
        ruleName,
      });
    }
  });
};

rule.ruleName = ruleName;
rule.messages = messages;

export default createPlugin(ruleName, rule);
