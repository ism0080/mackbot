/**
 * Smoke test for the generated login page's stylesheet.
 *
 * Run with: bun tests/login-page.smoke.mjs
 *
 * The login page is an HTML string, so stylelint never sees its inline
 * `<style>`. This extracts that stylesheet and runs it through the real
 * `web/stylelint.config.mjs`, which is the same enforcement the `.css` files
 * get: no hex, no `rgb()`/`hsl()`, no physical side properties, hover only
 * where hover exists, and motion behind the reduced-motion query. It also
 * checks the document keeps its promise of carrying no script and no token.
 */
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loginDocument } from "../src/login-page.ts";

const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const stylelint = (
  await import(pathToFileURL(webRequire.resolve("stylelint")).href)
).default;
const configFile = fileURLToPath(new URL("../web/stylelint.config.mjs", import.meta.url));

const failures = [];
const check = (label, condition, detail = "") => {
  if (!condition) failures.push(`${label}${detail === "" ? "" : `: ${detail}`}`);
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` (${detail})`}`);
};

for (const failed of [false, true]) {
  const document = loginDocument(failed);
  const stylesheet = /<style>([\s\S]*?)<\/style>/u.exec(document)?.[1];

  check(`the ${failed ? "failed" : "fresh"} page has one inline stylesheet`, stylesheet !== undefined);
  check("it has no script", !/<script\b/iu.test(document));
  check("it has no token value", !/name="token"[^>]*\bvalue=/iu.test(document));

  if (stylesheet === undefined) continue;

  const { results } = await stylelint.lint({ code: stylesheet, configFile });
  const warnings = results.flatMap((result) => result.warnings);

  for (const warning of warnings) {
    console.log(`       ${warning.line}:${warning.column} ${warning.rule} ${warning.text}`);
  }
  check(
    "its stylesheet obeys web/stylelint.config.mjs",
    warnings.length === 0,
    warnings.length === 0 ? "zero warnings" : `${warnings.length} warning(s)`,
  );
}

if (failures.length > 0) {
  console.error("login page smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("login page smoke passed");
process.exit(0);
