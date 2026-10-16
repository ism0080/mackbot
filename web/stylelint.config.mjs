// The good-css rules, enforced by command instead of by review.
//
// Every rule below is mandated by an entry in the good-css skill, or is a
// correctness rule for a mistake CSS itself half-accepts (a valid declaration
// that silently does nothing, or a removal that only breaks at runtime). The
// comment on each group names the entry, so the mapping can be checked line by
// line against https://good-css.com/skills/good-css. Where an entry's scope is
// ambiguous the reference file is the authority, and the rule is written to
// that scope; no stylistic preference of this project is added and no
// shareable config is used. The `mackbot/*` rules are the local plugin in
// ./stylelint/.
//
// This sheet is the whole app, so the two deliberate exceptions the design
// needs (`!important` on `[hidden]`, `overflow: hidden` under a line clamp)
// carry an inline disable in web/src/styles.css with its reason, rather than
// turning a rule off for the whole project.

import pluginRules from "./stylelint/index.mjs";

export default {
  plugins: pluginRules,
  rules: {
    /* =====================================================================
     * foundations.md · "Logical properties"
     *
     * "Use them in place of every left, right, top and bottom, in spacing,
     * borders, offsets and alignment." The entry names the four sides, so this
     * bans exactly the physical side longhands: the margin, padding and border
     * sides and their longhands, the four position offsets, scroll spacing and
     * the corner radii. It deliberately does NOT ban width, height, min/max-*
     * (not left/right/top/bottom) or overflow-x/-y and overscroll-behavior-x/-y
     * (not sides at all). The entry's own prescribed reset writes
     * `max-width: 100%` and `height: auto` on img/svg/video, so banning those
     * would set the source against itself.
     * ================================================================== */
    "property-layout-mappings": [
      "flow-relative",
      {
        ignoreProperties: [
          "/^(width|height|min-width|min-height|max-width|max-height)$/",
          "/^(overflow-x|overflow-y|overscroll-behavior-x|overscroll-behavior-y)$/",
          "/^contain-intrinsic-(width|height)$/",
        ],
      },
    ],

    /* =====================================================================
     * foundations.md · "OKLCH color"
     *
     * "Write colors in `oklch()` ... Never hardcode a second hex or an
     * `rgba()` for a hover, tint or transparent version." The derivable forms
     * (`transparent`, `currentColor`, the white/black keywords) stay legal.
     * ================================================================== */
    "color-no-hex": true,
    "function-disallowed-list": ["rgb", "rgba", "hsl", "hsla"],

    // "A written hue of `0` is red, and it pulls every mix toward red": a
    // zero-chroma oklch() with a written hue is the silent half of that rule,
    // and core stylelint has nothing that can see it.
    "mackbot/oklch-achromatic-hue-none": true,

    /* =====================================================================
     * foundations.md · "Fluid sizes with clamp()"
     *
     * The preferred value must pair a viewport unit with a font-relative one,
     * and both bounds must be in rem.
     * ================================================================== */
    "mackbot/fluid-clamp": true,

    /* =====================================================================
     * foundations.md · "Left out on purpose"
     *
     * "Never add `text-box` trim on `*`" — only the universal selector is
     * banned; a scoped `text-box` on a label is the technique.
     * ================================================================== */
    "rule-selector-property-disallowed-list": {
      "/\\*/": ["text-box"],
    },

    /* =====================================================================
     * interaction.md · "Hover styles only where hover exists"
     *
     * "Use it on every `:hover` rule, so a tap on a touch screen does not
     * leave the hover state stuck", inside the full query. Core stylelint
     * cannot see the @media a selector sits in.
     * ================================================================== */
    "mackbot/hover-in-hover-media": true,

    /* =====================================================================
     * interaction.md · "Press feedback", with the reduced-motion condition
     * restated by SKILL.md · "In all CSS"
     *
     * The transition that feedback needs, and any animation that moves or
     * scales, must sit inside `@media (prefers-reduced-motion: no-preference)`.
     * ================================================================== */
    "mackbot/motion-in-reduced-motion-media": true,

    // "Keep the scale between 0.95 and 0.98."
    "mackbot/press-scale-in-range": true,

    /* =====================================================================
     * One core rule carries the remaining value bans. Each key names its
     * entry.
     * ================================================================== */
    "declaration-property-value-disallowed-list": {
      // foundations.md · "Logical properties" — the entry's own example ends
      // with `text-align: start`.
      "text-align": ["/^left$/i", "/^right$/i"],
      "text-align-last": ["/^left$/i", "/^right$/i"],

      // foundations.md · "Left out on purpose" — never `text-rendering:
      // optimizeLegibility`.
      "text-rendering": ["/^optimizeLegibility$/i"],

      // interaction.md · "One focus ring with `:focus-visible`" — "Never write
      // `outline: none`". `outline: 0` is the same removal written another
      // way, and `outline-style: none` is the longhand that does it.
      // `outline-color: transparent` stays legal: the entry requires it for a
      // ring drawn with box-shadow so forced-colors mode can repaint it.
      outline: ["/^(?:none|0)$/i"],
      "outline-style": ["/^none$/i"],

      // SKILL.md · "In all CSS" — "Name its properties, never `all`, and never
      // use `ease-in`". The negative lookahead keeps `ease-in-out`, which the
      // entry does not ban, legal.
      transition: ["/\\ball\\b/", "/ease-in(?!-)/"],
      "transition-property": ["/^all$/i"],
      "transition-timing-function": ["/ease-in(?!-)/"],
      animation: ["/ease-in(?!-)/"],
      "animation-timing-function": ["/ease-in(?!-)/"],

      // SKILL.md · "In all CSS" — "Cut off overflow with `overflow: clip`."
      overflow: ["/\\bhidden\\b/"],
      "overflow-x": ["/\\bhidden\\b/"],
      "overflow-y": ["/\\bhidden\\b/"],
    },

    /* =====================================================================
     * Correctness only, with no good-css entry. Each catches a mistake CSS
     * accepts silently, so the sheet renders while being wrong.
     * ================================================================== */
    // An animation whose @keyframes are not in the file simply never runs.
    "no-unknown-animations": true,
    // A global !important defeats the cascade; each use must be a deliberate,
    // commented exception, as the `[hidden]` rule in web/src/styles.css is.
    "declaration-no-important": true,
  },
};
