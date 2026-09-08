import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for the FdbTrade API foundation (P01-02).
 *
 * The API layer is pure TypeScript running in Node — no DOM, no JSX — so the
 * `node` environment is used (unlike the frontend shell's jsdom setup).
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
