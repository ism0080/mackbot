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
      // Effect-idiom rules for the Worker and its deploy script.
      files: ["apps/api/alchemy.run.ts", "apps/api/src/**/*.ts"],
      rules: profiles.effect,
    },
    {
      // The Durable Object classes and the Worker entry are the promise
      // boundary: the Workers runtime, the Agents SDK and Pi Durable call
      // their methods as plain async RPCs and callbacks, outside any Effect
      // runtime. The timestamps they stamp on audit rows and runs are host
      // facts read at that boundary, so ambient time is allowed there and
      // nowhere else; every module they call reads time through Effect's
      // Clock or takes it as an argument.
      files: ["apps/api/src/index.ts", "apps/api/src/bot.ts", "apps/api/src/registry.ts"],
      rules: { "forge/no-ambient-nondeterminism": "off" },
    },
    {
      // WebCrypto: the session key is derived with HKDF, signed and verified
      // with HMAC, and bearer digests are compared with `timingSafeEqual`.
      // effect/Crypto offers none of these (only digests and random values)
      // and ships no WebCrypto layer, so these two modules call
      // `crypto.subtle` directly, each call wrapped as a typed
      // `WebCryptoFailure` (see src/errors.ts).
      files: ["apps/api/src/session.ts", "apps/api/src/chat-request.ts"],
      rules: { "forge/no-ambient-nondeterminism": "off" },
    },
  ],
  env: {
    builtin: true,
  },
});
