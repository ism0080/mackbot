import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Story and Scene run on the app's update and view; both are VNode-only,
    // so no DOM is installed. Scene drives interactions through the rendered
    // tree rather than a browser.
    include: ["tests/**/*.test.ts"],
  },
});
