-- R0.4 SQLite foundation. UTC values are canonical ISO-8601 text.
CREATE TABLE system_settings (
  key            TEXT PRIMARY KEY,
  value_json     TEXT NOT NULL CHECK(json_valid(value_json)),
  updated_at_utc TEXT NOT NULL
) STRICT;
