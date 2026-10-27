import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: foldkit(),
  server: {
    // The workspace root, two levels up: Vite must read both this app and
    // `packages/contract`, which the browser bundles through the workspace link.
    fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] },
  },
});
