/**
 * Smoke test for the sandbox seam (src/sandbox.ts).
 *
 * Run with: bun tests/sandbox.smoke.mjs
 *
 * Imports the module and exercises construction plus a few in-memory workspace
 * operations without any external dependency.
 */
const { createSandbox, inMemorySandbox } = await import("../src/sandbox.ts");

const ws = createSandbox({ rootPath: "/workspace", label: "smoke" });
if (ws.path !== "/workspace") {
  console.error("unexpected workspace path:", ws.path);
  process.exit(1);
}

const factoryWs = inMemorySandbox({ rootPath: "/tmp/scratch" });
if (factoryWs.path !== "/tmp/scratch") {
  console.error("factory path wrong:", factoryWs.path);
  process.exit(1);
}

await ws.write("hello.txt", "line one\nneedle here\nline three");
const content = await ws.read("hello.txt");
if (!content.includes("needle")) {
  console.error("read failed:", content);
  process.exit(1);
}

const entries = await ws.list("/");
if (!entries.some((e) => e.path === "/hello.txt" && e.type === "file")) {
  console.error("list missing file:", entries);
  process.exit(1);
}

const matches = await ws.search("needle");
if (matches.length !== 1 || matches[0].line !== 2) {
  console.error("search failed:", matches);
  process.exit(1);
}

try {
  await ws.run("echo hi");
  console.error("run unexpectedly succeeded");
  process.exit(1);
} catch (error) {
  if (!(error instanceof Error)) {
    console.error("run did not throw Error:", error);
    process.exit(1);
  }
}

console.log("sandbox smoke passed");
process.exit(0);
