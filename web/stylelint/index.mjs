// The good-css rules core stylelint cannot express, as one local plugin.
//
// Core stylelint rules see a declaration or a rule on its own. Whatever a rule
// needs to know about the tree around it — the @media it sits in, the
// @keyframes an animation names, the selector that a value is meant to bound —
// lives in the rules below. Each file names the good-css entry it comes from.
//
// This is a plain ESM module beside the config, not a package, in the same
// shape as the vendored oxlint plugin under tools/oxlint/.

import fluidClamp from "./rules/fluid-clamp.mjs";
import hoverInHoverMedia from "./rules/hover-in-hover-media.mjs";
import motionInReducedMotionMedia from "./rules/motion-in-reduced-motion-media.mjs";
import oklchAchromaticHueNone from "./rules/oklch-achromatic-hue-none.mjs";
import pressScaleInRange from "./rules/press-scale-in-range.mjs";

export default [
  fluidClamp,
  hoverInHoverMedia,
  motionInReducedMotionMedia,
  oklchAchromaticHueNone,
  pressScaleInRange,
];
