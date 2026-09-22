/**
 * Typed server-side API configuration (P01-02/P01-03).
 *
 * The raw environment is parsed with zod at import time so a malformed
 * configuration fails fast instead of surfacing as a runtime 500. This is the
 * ONLY module in the backend TypeScript app allowed to read `process.env`
 * (enforced by `tests/test_api_foundation_contracts.py`; the standalone
 * migration CLI `src/db/migrate.mjs` is the one deliberate exception — it is
 * a Node CLI outside the Next.js app, never bundled).
 *
 * R0.4 removes network database credentials entirely. The only durable-state
 * configuration is an optional absolute local data root and a bounded SQLite
 * busy timeout. The module is guarded server-only.
 */
import { z } from "zod";

import { assertServerOnly } from "@/server-only";

assertServerOnly();

/**
 * Deployment environment. Uses the same value set as the P00-03 Python
 * config contract (`infra.config.Env`) so both layers agree on naming.
 */
export const API_ENVIRONMENTS = [
  "development",
  "testing",
  "staging",
  "production",
] as const;

export const apiEnvSchema = z.object({
  FDB_APP_ENV: z.enum(API_ENVIRONMENTS).default("development"),
  FDB_API_SERVICE_NAME: z.string().min(1).default("fdbtrade-api"),
  FDB_API_VERSION: z.string().min(1).default("0.1.0"),
  /** Maximum accepted request body size in bytes (boundary guard). */
  FDB_API_MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(10 * 1024 * 1024)
    .default(65_536),

  // Absolute when set. Unset means repository-local `.fdbtrade`.
  FDB_DATA_ROOT: z.string().min(1).optional(),
  FDB_SQLITE_BUSY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1)
    .max(60_000)
    .default(5_000),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

const runtimeEnv =
  process.env.NODE_ENV === "test" && !process.env.FDB_APP_ENV
    ? { ...process.env, FDB_APP_ENV: "testing" }
    : process.env;

export const apiEnv: ApiEnv = apiEnvSchema.parse(runtimeEnv);
