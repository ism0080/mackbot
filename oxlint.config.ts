import { defineConfig } from "oxlint";

import { profiles } from "./tools/oxlint/profiles.ts";

export default defineConfig({
  plugins: ["typescript", "unicorn", "oxc"],
  // tools/oxlint is vendored from the forge repo — it verifies itself via `bun run tools:oxlint`
  ignorePatterns: ["node_modules", "dist", ".alchemy", "tools/oxlint"],
  jsPlugins: [
    {
      name: "forge",
      specifier: "./tools/oxlint/index.ts",
    },
  ],
  categories: {
    correctness: "error",
  },
  rules: {
    complexity: "error",
    ...profiles.core,
  },
  overrides: [
    {
      // Effect-idiom rules for the Effect surface (alchemy.run.ts);
      // src/ is Pi-based plain TS, so the effect profile stays off there
      files: ["alchemy.run.ts"],
      rules: profiles.effect,
    },
  ],
  env: {
    builtin: true,
  },
});
