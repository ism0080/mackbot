import { defineConfig } from "oxlint";

import { profiles } from "@ism0080/oxlint-plugin-forge/profiles";

export default defineConfig({
  plugins: ["typescript", "unicorn", "oxc"],
  // tools/oxlint is vendored from the forge repo — it verifies itself via
  // `bun run tools:oxlint`
  // apps/web is the Foldkit app: it lints itself with the Foldkit preset in
  // apps/web/.oxlintrc.json, which the core profile here would only fight.
  ignorePatterns: ["node_modules", "dist", ".alchemy", "tools/oxlint", "apps/web"],
  jsPlugins: [
    {
      name: "forge",
      specifier: "@ism0080/oxlint-plugin-forge",
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
      // Effect-idiom rules for the Effect surface (apps/api/alchemy.run.ts).
      // apps/api/src wraps the Pi/Cloudflare promise+callback SDKs at its
      // boundaries, where rules such as no-try-catch would fight deliberate
      // boundary code, so the effect profile stays off there.
      files: ["apps/api/alchemy.run.ts"],
      rules: profiles.effect,
    },
  ],
  env: {
    builtin: true,
  },
});
