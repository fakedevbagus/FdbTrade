/**
 * Typed server-side API configuration (P01-02).
 *
 * The raw environment is parsed with zod at import time so a malformed
 * configuration fails fast instead of surfacing as a runtime 500. This is the
 * ONLY module in the backend allowed to read `process.env` (enforced by
 * `tests/test_api_foundation_contracts.py`).
 *
 * SECURITY: no secret ever belongs in this schema. Operational knobs only —
 * there are no credentials, tokens, or connection strings here. The module is
 * guarded server-only so it can never be bundled for the browser.
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
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export const apiEnv: ApiEnv = apiEnvSchema.parse(process.env);
