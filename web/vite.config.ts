import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: foldkit(),
  resolve: {
    alias: {
      "@mackbot/web-contract": fileURLToPath(
        new URL("../src/web-contract.ts", import.meta.url),
      ),
    },
  },
  server: {
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
  },
});
