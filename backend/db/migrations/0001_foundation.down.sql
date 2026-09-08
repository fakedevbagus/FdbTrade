-- FdbTrade migration 0001_foundation rollback (P01-03).
-- Reverses 0001_foundation by dropping the foundation schema objects.
-- The migration ledger (public.schema_migrations) is managed by the runner
-- and intentionally left in place.

DROP TABLE IF EXISTS fdb.system_settings;
DROP SCHEMA IF EXISTS fdb;
