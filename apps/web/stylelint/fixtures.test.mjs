#!/usr/bin/env bun
// Proves every good-css stylelint rule fires.
//
// A rule that cannot fail is worse than no rule, because it looks like
// enforcement. Each fixture below is a file that breaks exactly one configured
// rule (or, for the entries that share core stylelint's
// declaration-property-value-disallowed-list, one configured key of it). This
// test lints each fixture on its own with the real apps/web/stylelint.config.mjs and
// asserts the exact set of rule ids it reported, then lints the real stylesheet
// and asserts zero errors. It also asserts that every rule enabled in the
// config is proven by one of the fixtures, so adding a rule without a fixture
// fails here.
//
// The mapping from each rule to the good-css entry it comes from lives in
// stylelint.config.mjs, not here.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import stylelint from "stylelint";

import config from "../stylelint.config.mjs";

const here = new URL(".", import.meta.url);
const configFile = fileURLToPath(new URL("../stylelint.config.mjs", here));
const fixtureDir = fileURLToPath(new URL("fixtures", here));
const sheet = fileURLToPath(new URL("../src/styles.css", here));

/** @type {{file: string, ruleIds: string[]}[]} */
const cases = [
  { file: "01-logical-side-properties.css", ruleIds: ["property-layout-mappings"] },
  {
    file: "02-logical-text-align.css",
    ruleIds: ["declaration-property-value-disallowed-list"],
  },
  {
    file: "03-focus-not-removed.css",
    ruleIds: ["declaration-property-value-disallowed-list"],
  },
  { file: "04-oklch-no-hex.css", ruleIds: ["color-no-hex"] },
  { file: "05-oklch-no-rgb.css", ruleIds: ["function-disallowed-list"] },
  { file: "06-oklch-achromatic-hue.css", ruleIds: ["mackbot/oklch-achromatic-hue-none"] },
  { file: "07-clamp-bare-viewport.css", ruleIds: ["mackbot/fluid-clamp"] },
  { file: "08-clamp-rem-bounds.css", ruleIds: ["mackbot/fluid-clamp"] },
  {
    file: "09-transition-no-all.css",
    ruleIds: ["declaration-property-value-disallowed-list"],
  },
  {
    file: "10-transition-no-ease-in.css",
    ruleIds: ["declaration-property-value-disallowed-list"],
  },
  {
    file: "11-overflow-clip.css",
    ruleIds: ["declaration-property-value-disallowed-list"],
  },
  {
    file: "12-no-legibility-text-rendering.css",
    ruleIds: ["declaration-property-value-disallowed-list"],
  },
  {
    file: "13-no-text-box-on-universal.css",
    ruleIds: ["rule-selector-property-disallowed-list"],
  },
  { file: "14-hover-in-hover-media.css", ruleIds: ["mackbot/hover-in-hover-media"] },
  {
    file: "15-motion-reduced-motion-transition.css",
    ruleIds: ["mackbot/motion-in-reduced-motion-media"],
  },
  {
    file: "16-motion-reduced-motion-animation.css",
    ruleIds: ["mackbot/motion-in-reduced-motion-media"],
  },
  { file: "17-press-scale-in-range.css", ruleIds: ["mackbot/press-scale-in-range"] },
  { file: "18-unknown-animation.css", ruleIds: ["no-unknown-animations"] },
  { file: "19-no-important.css", ruleIds: ["declaration-no-important"] },
];

/** Files that must stay clean, proving a rule does not ban more than its entry. */
const allowed = ["allowed-logical-size.css"];

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
    throw new Error(`${path} did not parse: ${parseErrors.map((error) => error.text).join(", ")}`);
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

  console.log(`${ok ? "✔" : "✘"} ${testCase.file} → ${ruleIds.join(", ") || "(none)"}`);

  if (ok) for (const ruleId of ruleIds) proved.add(ruleId);
  else
    failures.push(
      `${testCase.file}: expected ${expected.join(", ") || "(none)"}, got ${ruleIds.join(", ") || "(none)"}`,
    );
}

for (const file of allowed) {
  const { ruleIds, detail } = await lintFile(join(fixtureDir, file));
  const ok = ruleIds.length === 0;

  console.log(`${ok ? "✔" : "✘"} ${file} → ${detail || "clean"}`);

  if (!ok) failures.push(`${file}: expected no errors, got ${ruleIds.join(", ")}`);
}

// Every rule enabled in the config must be proven above.
const enabled = Object.entries(config.rules)
  .filter(([, value]) => Boolean(value))
  .map(([ruleId]) => ruleId)
  .sort();
const unproven = enabled.filter((ruleId) => !proved.has(ruleId));

console.log(`\n${proved.size}/${enabled.length} configured rules proved by a fixture.`);

if (unproven.length > 0) {
  failures.push(`rules enabled with no firing fixture: ${unproven.join(", ")}`);
}

// The real stylesheet must be clean.
const sheetResult = await lintFile(sheet);
console.log(
  sheetResult.ruleIds.length === 0
    ? "✔ apps/web/src/styles.css → zero errors"
    : `✘ apps/web/src/styles.css → ${sheetResult.detail}`,
);
console.log(`  (linted ${(await readFile(sheet, "utf8")).length} bytes of the real stylesheet)`);

if (sheetResult.ruleIds.length > 0) {
  failures.push(`apps/web/src/styles.css: ${sheetResult.detail}`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failing:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("\nAll good-css rules fire, and the stylesheet is clean.");
