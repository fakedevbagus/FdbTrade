-- FdbTrade migration 0001_foundation (P01-03).
-- Establishes the base schema conventions. No business tables.
--
-- Binding conventions for every later migration (see ADR-0007):
--   * Naming: snake_case; application objects live schema-qualified under `fdb`.
--   * Primary keys: uuid v4 via gen_random_uuid() (core in PostgreSQL 16).
--   * Timestamps: timestamptz with DEFAULT now() — stored UTC, passed UTC
--     (ADR-0004). Never timestamp without time zone; never local-time defaults.
--   * Idempotency: write paths carry natural idempotency keys; deduplication
--     is enforced by database constraints, never application code alone.
--   * The migration ledger (`public.schema_migrations`) is managed by the
--     runner (src/db/migrate.mjs) and is deliberately NOT part of any
--     migration file.

CREATE SCHEMA IF NOT EXISTS fdb;

COMMENT ON SCHEMA fdb IS
  'FdbTrade application schema. Conventions: snake_case, uuid v4 PKs, timestamptz UTC (ADR-0004). See docs/adr/ADR-0007.';

CREATE TABLE IF NOT EXISTS fdb.system_settings (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE fdb.system_settings IS
  'Foundation key/value settings (P01-03). Generic and stable; business tables land with their owning phase prompts.';
