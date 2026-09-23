-- R0.10 durable observability for local operational drills.
CREATE TABLE operational_events (
  event_id          TEXT PRIMARY KEY,
  sequence_no       INTEGER NOT NULL UNIQUE CHECK(sequence_no >= 1),
  event_type        TEXT NOT NULL CHECK(event_type IN (
                      'backup_created',
                      'restore_verified',
                      'deployment_drill_verified'
                    )),
  status            TEXT NOT NULL CHECK(status IN ('passed', 'failed')),
  artifact_digest   TEXT CHECK(artifact_digest IS NULL OR length(artifact_digest) = 64),
  details_json      TEXT NOT NULL CHECK(json_valid(details_json)),
  event_digest      TEXT NOT NULL UNIQUE CHECK(length(event_digest) = 64),
  occurred_at_utc   TEXT NOT NULL,
  created_at_utc    TEXT NOT NULL
) STRICT;

CREATE TRIGGER operational_events_sequence_guard
BEFORE INSERT ON operational_events
BEGIN
  SELECT CASE
    WHEN NEW.sequence_no <> COALESCE((SELECT MAX(sequence_no) + 1 FROM operational_events), 1)
    THEN RAISE(ABORT, 'operational event sequence must be contiguous')
  END;
END;

CREATE TRIGGER operational_events_no_update
BEFORE UPDATE ON operational_events
BEGIN
  SELECT RAISE(ABORT, 'operational events are immutable');
END;

CREATE TRIGGER operational_events_no_delete
BEFORE DELETE ON operational_events
BEGIN
  SELECT RAISE(ABORT, 'operational events are append-only');
END;
