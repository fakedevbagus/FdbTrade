-- FdbTrade migration 0002_auth_foundation rollback (P01-04).
-- Reverses 0002 by dropping the auth tables in dependency order.
-- The migration ledger is runner-owned and intentionally untouched.

DROP TABLE IF EXISTS fdb.sessions;
DROP TABLE IF EXISTS fdb.user_profiles;
DROP TABLE IF EXISTS fdb.users;
