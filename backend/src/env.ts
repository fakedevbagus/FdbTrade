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
 * SECURITY: server-side credentials (e.g. `FDB_DB_PASSWORD`) are read from
 * the environment at runtime ONLY — never hardcoded, never logged, never
 * serialized, never shipped to a browser. The module is guarded server-only.
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

/** PostgreSQL sslmode values (server side; see postgres docs). */
export const DB_SSL_MODES = [
  "disable",
  "allow",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
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

  // --- database (P01-03; names mirror the P00-03 Python config contract) --- //
  FDB_DB_HOST: z.string().min(1).default("localhost"),
  // Note: the local Docker compose maps the container to host port 15432
  // (5432 is frequently occupied by unrelated local services); deployments
  // may use any port.
  FDB_DB_PORT: z.coerce.number().int().min(1).max(65_535).default(15_432),
  FDB_DB_NAME: z.string().min(1).default("fdbtrade"),
  FDB_DB_USER: z.string().min(1).default("fdbtrade"),
  /**
   * Runtime credential. Empty by default in development/testing; required by
   * the deployment config contract in staging/production (P00-03). Never
   * logged, never serialized into responses.
   */
  FDB_DB_PASSWORD: z.string().default(""),
  FDB_DB_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  FDB_DB_SSL_MODE: z.enum(DB_SSL_MODES).default("disable"),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export const apiEnv: ApiEnv = apiEnvSchema.parse(process.env);
