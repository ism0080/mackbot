import { defineConfig } from "oxlint";

import { profiles } from "./tools/oxlint/profiles.ts";

export default defineConfig({
  plugins: ["typescript", "unicorn", "oxc"],
  // tools/oxlint is vendored from the forge repo — it verifies itself via `bun run tools:oxlint`
  // web/ is the Foldkit app: it lints itself with the Foldkit preset in
  // web/.oxlintrc.json, which the core profile here would only fight.
  ignorePatterns: ["node_modules", "dist", ".alchemy", "tools/oxlint", "web"],
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
      // Effect-idiom rules for the Effect surface (alchemy.run.ts). src/ wraps
      // the Pi/Cloudflare promise+callback SDKs at its boundaries, where rules
      // such as no-try-catch would fight deliberate boundary code, so the effect
      // profile stays off there.
      files: ["alchemy.run.ts"],
      rules: profiles.effect,
    },
  ],
  env: {
    builtin: true,
  },
});
