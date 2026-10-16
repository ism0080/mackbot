#!/usr/bin/env bun
// Proves every good-css stylelint rule fires.
//
// A rule that cannot fail is worse than no rule, because it looks like
// enforcement. Each fixture below is a file that breaks exactly one configured
// rule (or, for the entries that share core stylelint's
// declaration-property-value-disallowed-list, one configured key of it). This
// test lints each fixture on its own with the real web/stylelint.config.mjs and
// asserts the exact set of rule ids it reported, then lints the real stylesheet
// and asserts zero errors. It also asserts that every rule enabled in the
// config is proven by one of the fixtures, so adding a rule without a fixture
// fails here.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import stylelint from "stylelint";

import config from "../stylelint.config.mjs";

const here = new URL(".", import.meta.url);
const configFile = fileURLToPath(new URL("../stylelint.config.mjs", here));
const fixtureDir = fileURLToPath(new URL("fixtures", here));
const sheet = fileURLToPath(new URL("../src/styles.css", here));

/** @type {{file: string, entry: string, ruleIds: string[]}[]} */
const cases = [
  {
    file: "01-logical-side-properties.css",
    entry: 'foundations.md · "Logical properties"',
    ruleIds: ["property-layout-mappings"],
  },
  {
    file: "02-logical-text-align.css",
    entry: 'foundations.md · "Logical properties" (alignment)',
    ruleIds: ["declaration-property-value-disallowed-list"],
  },
  {
    file: "03-focus-not-removed.css",
    entry: 'interaction.md · "One focus ring with :focus-visible"',
    ruleIds: ["declaration-property-value-disallowed-list"],
  },
  {
    file: "04-oklch-no-hex.css",
    entry: 'foundations.md · "OKLCH color"',
    ruleIds: ["color-no-hex"],
  },
  {
    file: "05-oklch-no-rgb.css",
    entry: 'foundations.md · "OKLCH color"',
    ruleIds: ["function-disallowed-list"],
  },
  {
    file: "06-oklch-achromatic-hue.css",
    entry: 'foundations.md · "OKLCH color"',
    ruleIds: ["mackbot/oklch-achromatic-hue-none"],
  },
  {
    file: "07-clamp-bare-viewport.css",
    entry: 'foundations.md · "Fluid sizes with clamp()"',
    ruleIds: ["mackbot/fluid-clamp"],
  },
  {
    file: "08-clamp-rem-bounds.css",
    entry: 'foundations.md · "Fluid sizes with clamp()"',
    ruleIds: ["mackbot/fluid-clamp"],
  },
  {
    file: "09-transition-no-all.css",
    entry: 'SKILL.md · "In all CSS" (name the transition properties)',
    ruleIds: ["declaration-property-value-disallowed-list"],
  },
  {
    file: "10-transition-no-ease-in.css",
    entry: 'SKILL.md · "In all CSS" (never ease-in)',
    ruleIds: ["declaration-property-value-disallowed-list"],
  },
  {
    file: "11-overflow-clip.css",
    entry: 'SKILL.md · "In all CSS" (overflow: clip)',
    ruleIds: ["declaration-property-value-disallowed-list"],
  },
  {
    file: "12-no-legibility-text-rendering.css",
    entry: 'foundations.md · "Left out on purpose"',
    ruleIds: ["declaration-property-value-disallowed-list"],
  },
  {
    file: "13-no-text-box-on-universal.css",
    entry: 'foundations.md · "Left out on purpose"',
    ruleIds: ["rule-selector-property-disallowed-list"],
  },
  {
    file: "14-hover-in-hover-media.css",
    entry: 'interaction.md · "Hover styles only where hover exists"',
    ruleIds: ["mackbot/hover-in-hover-media"],
  },
  {
    file: "15-motion-reduced-motion-transition.css",
    entry: 'interaction.md · "Press feedback" (reduced motion)',
    ruleIds: ["mackbot/motion-in-reduced-motion-media"],
  },
  {
    file: "16-motion-reduced-motion-animation.css",
    entry: 'interaction.md · "Press feedback" (reduced motion)',
    ruleIds: ["mackbot/motion-in-reduced-motion-media"],
  },
  {
    file: "17-press-scale-in-range.css",
    entry: 'interaction.md · "Press feedback" (scale range)',
    ruleIds: ["mackbot/press-scale-in-range"],
  },
  {
    file: "18-unknown-animation.css",
    entry: "correctness: an unknown @keyframes name",
    ruleIds: ["no-unknown-animations"],
  },
  {
    file: "19-no-important.css",
    entry: "correctness: a global !important",
    ruleIds: ["declaration-no-important"],
  },
];

/** Files that must stay clean, proving a rule does not ban more than its entry. */
const allowed = [
  {
    file: "allowed-logical-size.css",
    entry:
      'foundations.md · "Logical properties" does not cover width, height or the overflow axes',
  },
];

/**
 * @param {string} path
 * @returns {Promise<{ruleIds: string[], detail: string}>}
 */
async function lintFile(path) {
  const { results } = await stylelint.lint({ files: [path], configFile });
  const warnings = results.flatMap((result) => result.warnings);
  const parseErrors = results.flatMap((result) => result.parseErrors ?? []);
  const ruleIds = [...new Set(warnings.map((warning) => warning.rule))].sort();
  const detail = warnings
    .map((warning) => `${warning.line}:${warning.column} ${warning.rule}`)
    .join(", ");

  if (parseErrors.length > 0) {
    throw new Error(`${path} did not parse: ${parseErrors.map((e) => e.text).join(", ")}`);
  }

  return { ruleIds, detail };
}

/** @param {string[]} actual @param {string[]} expected */
function same(actual, expected) {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

const failures = [];
const proved = new Set();

for (const testCase of cases) {
  const path = join(fixtureDir, testCase.file);
  const expected = [...testCase.ruleIds].sort();
  const { ruleIds } = await lintFile(path);
  const ok = same(ruleIds, expected);

  console.log(
    `${ok ? "✔" : "✘"} ${testCase.file} → ${ruleIds.join(", ") || "(none)"}` +
      `  [${testCase.entry}]`,
  );

  if (!ok) failures.push(`${testCase.file}: expected ${expected.join(", ")}, got ${ruleIds.join(", ") || "(none)"}`);
  else for (const ruleId of ruleIds) proved.add(ruleId);
}

for (const testCase of allowed) {
  const path = join(fixtureDir, testCase.file);
  const { ruleIds, detail } = await lintFile(path);
  const ok = ruleIds.length === 0;

  console.log(`${ok ? "✔" : "✘"} ${testCase.file} → ${detail || "clean"}  [${testCase.entry}]`);

  if (!ok) failures.push(`${testCase.file}: expected no errors, got ${ruleIds.join(", ")}`);
}

// Every rule enabled in the config must be proven above.
const enabled = Object.entries(config.rules)
  .filter(([, value]) => Boolean(value))
  .map(([ruleId]) => ruleId)
  .sort();
const unproven = enabled.filter((ruleId) => !proved.has(ruleId));

console.log(
  `\n${proved.size}/${enabled.length} configured rules proved by a fixture.`,
);

if (unproven.length > 0) {
  failures.push(`rules enabled with no firing fixture: ${unproven.join(", ")}`);
}

// The real stylesheet must be clean.
const sheetResult = await lintFile(sheet);
console.log(
  sheetResult.ruleIds.length === 0
    ? "✔ web/src/styles.css → zero errors"
    : `✘ web/src/styles.css → ${sheetResult.detail}`,
);

if (sheetResult.ruleIds.length > 0) {
  failures.push(`web/src/styles.css: ${sheetResult.detail}`);
}

const stylesheetBytes = (await readFile(sheet, "utf8")).length;
console.log(`  (linted ${stylesheetBytes} bytes of the real stylesheet)`);

if (failures.length > 0) {
  console.error(`\n${failures.length} failing:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("\nAll good-css rules fire, and the stylesheet is clean.");
