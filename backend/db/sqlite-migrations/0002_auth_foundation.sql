-- Private single-user identity and durable opaque sessions.
CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  singleton_key  INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK(singleton_key = 1),
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  mfa_enabled    INTEGER NOT NULL DEFAULT 0 CHECK(mfa_enabled IN (0, 1)),
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
) STRICT;

CREATE TABLE user_profiles (
  user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name   TEXT,
  timezone       TEXT NOT NULL DEFAULT 'UTC' CHECK(timezone = 'UTC'),
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  id               TEXT PRIMARY KEY,
  token_hash       TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at_utc   TEXT NOT NULL,
  expires_at_utc   TEXT NOT NULL,
  last_used_at_utc TEXT NOT NULL
) STRICT;

CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_utc_idx ON sessions(expires_at_utc);
