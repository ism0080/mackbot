# @ism0080/oxlint-plugin-forge

Reusable Oxlint rules for Forge projects. Rules are grouped into `core`, `effect`, `react`, and
`xstate` profiles.

JavaScript plugins must be registered separately from their rules. Use an explicit alias so rule
names remain stable if the package name changes:

```ts
import { defineConfig } from "oxlint";
import { profiles } from "@ism0080/oxlint-plugin-forge/profiles";

export default defineConfig({
  jsPlugins: [
    {
      name: "forge",
      specifier: "@ism0080/oxlint-plugin-forge",
    },
  ],
  rules: {
    ...profiles.core,
    ...profiles.effect,
  },
});
```

JSON configuration can register the plugin and enable individual rules:

```json
{
  "jsPlugins": [
    {
      "name": "forge",
      "specifier": "@ism0080/oxlint-plugin-forge"
    }
  ],
  "rules": {
    "forge/no-direct-fetch": "error"
  }
}
```

Use `allRules` to enable every rule, or `profile(name, namespace)` when the plugin is registered
under a custom alias. Oxlint JavaScript plugin support is currently alpha, so compatibility is
verified against the package's declared Oxlint peer range.
