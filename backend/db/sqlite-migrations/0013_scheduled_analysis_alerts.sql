-- R1.18 durable scheduled analysis queue and in-app alert authority.
CREATE TABLE scheduled_analysis_work (
  work_id          TEXT PRIMARY KEY,
  cycle_id         TEXT UNIQUE,
  instrument       TEXT NOT NULL CHECK(instrument IN (
                     'EURUSD','GBPUSD','USDJPY','USDCHF','AUDUSD','USDCAD','NZDUSD'
                   )),
  timeframe        TEXT NOT NULL CHECK(timeframe IN ('15m','1h','4h')),
  range_start_utc  TEXT NOT NULL,
  range_end_utc    TEXT NOT NULL,
  status           TEXT NOT NULL CHECK(status IN (
                     'pending','running_ingest','ingested','running_analyze',
                     'analyzed','running_emit','alerted','failed'
                   )),
  dataset_id       TEXT REFERENCES market_data_datasets(dataset_id) ON DELETE RESTRICT,
  signal_run_id    TEXT REFERENCES signal_evaluation_runs(run_id) ON DELETE RESTRICT,
  signal_outcome   TEXT CHECK(signal_outcome IN ('candidate','wait','blocked')),
  decision_id      TEXT,
  alert_event_id   TEXT,
  failure_reason   TEXT,
  created_at_utc   TEXT NOT NULL,
  updated_at_utc   TEXT NOT NULL,
  UNIQUE(instrument, timeframe, range_end_utc),
  CHECK(range_start_utc < range_end_utc)
) STRICT;

CREATE INDEX scheduled_analysis_work_status_idx
  ON scheduled_analysis_work(status, range_end_utc, instrument, timeframe);

CREATE TABLE alert_preferences (
  singleton_id     INTEGER PRIMARY KEY CHECK(singleton_id = 1),
  preferences_json TEXT NOT NULL,
  updated_at_utc   TEXT NOT NULL
) STRICT;

CREATE TABLE alert_events (
  event_id         TEXT PRIMARY KEY,
  decision_id      TEXT NOT NULL,
  event_class      TEXT NOT NULL CHECK(event_class IN (
                     'signal_created','signal_expired','decision_wait'
                   )),
  recorded_at_utc  TEXT NOT NULL,
  status           TEXT NOT NULL CHECK(status IN (
                     'pending','delivered','failed','skipped'
                   )),
  attempts         INTEGER NOT NULL CHECK(attempts >= 0),
  last_error       TEXT,
  message          TEXT NOT NULL,
  created_by       TEXT NOT NULL CHECK(created_by IN ('scheduler','operator')),
  UNIQUE(decision_id, event_class)
) STRICT;

CREATE INDEX alert_events_recorded_idx
  ON alert_events(recorded_at_utc, event_id);

CREATE TRIGGER alert_events_identity_immutable
BEFORE UPDATE ON alert_events
WHEN NEW.event_id <> OLD.event_id
  OR NEW.decision_id <> OLD.decision_id
  OR NEW.event_class <> OLD.event_class
  OR NEW.recorded_at_utc <> OLD.recorded_at_utc
  OR NEW.message <> OLD.message
  OR NEW.created_by <> OLD.created_by
BEGIN
  SELECT RAISE(ABORT, 'alert event identity is immutable');
END;

CREATE TRIGGER alert_events_no_delete
BEFORE DELETE ON alert_events
BEGIN
  SELECT RAISE(ABORT, 'alert events are durable evidence');
END;