-- Durable append-only privileged-change audit authority.
CREATE TABLE audit_events (
  seq             INTEGER PRIMARY KEY,
  event_id        TEXT NOT NULL UNIQUE,
  at_utc          TEXT NOT NULL,
  actor           TEXT NOT NULL,
  action          TEXT NOT NULL,
  subject_type    TEXT NOT NULL,
  subject_id      TEXT NOT NULL,
  before_json     TEXT CHECK(before_json IS NULL OR json_valid(before_json)),
  after_json      TEXT NOT NULL CHECK(json_valid(after_json)),
  correlation_id  TEXT NOT NULL,
  source          TEXT NOT NULL
) STRICT;

CREATE INDEX audit_events_subject_id_seq_idx ON audit_events(subject_id, seq);

CREATE TRIGGER audit_events_chronology
BEFORE INSERT ON audit_events
WHEN NEW.at_utc < COALESCE((SELECT at_utc FROM audit_events ORDER BY seq DESC LIMIT 1), NEW.at_utc)
BEGIN
  SELECT RAISE(ABORT, 'audit events must be appended in UTC chronology');
END;

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;
