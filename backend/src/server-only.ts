/**
 * Server-only boundary guard (P01-02).
 *
 * Modules that hold server-side configuration or privileged state import
 * `assertServerOnly()` at module scope. If such a module is ever pulled into a
 * browser bundle the import fails loudly at runtime instead of silently
 * shipping server internals to the client.
 *
 * This is a deliberate, dependency-free guard (the npm `server-only` package
 * does the same job at build time; this guard also covers plain Node tests
 * and non-Next entry points).
 */
export function assertServerOnly(): void {
  const looksLikeBrowser =
    typeof window !== "undefined" || typeof document !== "undefined";
  if (looksLikeBrowser) {
    throw new Error(
      "server-only module imported into a browser bundle (boundary violation)",
    );
  }
}
