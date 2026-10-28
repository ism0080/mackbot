import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The secrets file and the Alchemy project live above this package.
    // `alchemy/Test` needs the machine's real network and child processes, so
    // the suite runs in a forked Node process, not a worker thread.
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 600_000,
    pool: "forks",
    fileParallelism: false,
  },
});
