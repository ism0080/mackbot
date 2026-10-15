/**
 * Smoke test for the operation-id builders (src/operation.ts).
 *
 * Run with: bun tests/operation.smoke.mjs
 *
 * Pure logic: checks the origin read back from each id shape and the idempotent
 * namespacing that makes an echoed id reuse the same operation. No credentials
 * needed.
 */
const { cronOperationId, delegateOperationId, httpOperationId, originOf } = await import(
  "../src/operation.ts"
);

const failures = [];

const expect = (label, actual, expected) => {
  if (actual !== expected) failures.push(`${label}: expected ${expected}, got ${actual}`);
};

expect("origin of cron id", originOf("cron:hermes:1750000000000"), "cron");
expect("origin of delegate id", originOf("delegate:hermes:abc"), "delegate");
expect("origin of http id", originOf("http:abc"), "http");
expect("origin of unprefixed id", originOf("abc"), "http");

const generatedHttp = httpOperationId(undefined);
if (!generatedHttp.startsWith("http:")) {
  failures.push(`generated http id missing prefix: ${generatedHttp}`);
}
if (httpOperationId(undefined) === generatedHttp) {
  failures.push("two generated http ids are equal");
}
expect("http namespaces a bare id", httpOperationId("abc"), "http:abc");
expect("http honors an echoed id", httpOperationId("http:abc"), "http:abc");
expect("http cannot claim the cron namespace", httpOperationId("cron:x"), "http:cron:x");

expect("cron id", cronOperationId("hermes", 1750000000000), "cron:hermes:1750000000000");

const generatedDelegate = delegateOperationId("hermes", undefined);
if (!generatedDelegate.startsWith("delegate:hermes:")) {
  failures.push(`generated delegate id missing prefix: ${generatedDelegate}`);
}
if (delegateOperationId("hermes", undefined) === generatedDelegate) {
  failures.push("two generated delegate ids are equal");
}
expect("delegate namespaces a bare id", delegateOperationId("hermes", "abc"), "delegate:hermes:abc");
expect(
  "delegate honors an echoed id",
  delegateOperationId("hermes", "delegate:hermes:abc"),
  "delegate:hermes:abc",
);

if (failures.length > 0) {
  console.error("operation smoke FAILED:");
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("operation smoke passed");
process.exit(0);
