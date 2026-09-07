import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for the FdbTrade web shell (P01-01).
 *
 * Vite 8 transforms TSX with oxc (not esbuild). The app tsconfig uses
 * `jsx: "preserve"` (required by Next), so the automatic JSX runtime must be
 * set explicitly here or oxc would pass JSX through untransformed.
 */
export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic",
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
