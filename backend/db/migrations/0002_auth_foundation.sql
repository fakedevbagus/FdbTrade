-- FdbTrade migration 0002_auth_foundation (P01-04).
-- Private single-user authentication: users, sessions, user profiles.
--
-- Conventions (ADR-0007/ADR-0008): snake_case under `fdb`, uuid v4 PKs,
-- timestamptz UTC (ADR-0004), idempotency/constraint-enforced.
--
-- Security notes:
--   * `password_hash` stores a scrypt hash (node:crypto), NEVER a password.
--   * `sessions.token_hash` stores sha256(token); the raw token exists only
--     in the httpOnly cookie (ADR-0008).
--   * `mfa_enabled` is a reserved state flag (default false) so a later
--     MFA prompt can build on this schema; it gates nothing today.
--   * Password/session values must never be logged (enforced by tests).

CREATE TABLE fdb.users (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text        NOT NULL UNIQUE,
  password_hash text        NOT NULL,
  mfa_enabled   boolean     NOT NULL DEFAULT false,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE fdb.users IS
  'Single-user identity store (P01-04). password_hash is scrypt; never a secret value.';

CREATE TABLE fdb.user_profiles (
  user_id     uuid        PRIMARY KEY REFERENCES fdb.users(id) ON DELETE CASCADE,
  display_name text,
  timezone    text        NOT NULL DEFAULT 'UTC',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE fdb.user_profiles IS
  'Per-user profile data (P01-04). No secrets, no trading data.';

CREATE TABLE fdb.sessions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text        NOT NULL UNIQUE,
  user_id      uuid        NOT NULL REFERENCES fdb.users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_id_idx    ON fdb.sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON fdb.sessions (expires_at);

COMMENT ON TABLE fdb.sessions IS
  'DB-backed sessions (survive restarts). token_hash = sha256(raw token); raw token only in the httpOnly cookie.';
