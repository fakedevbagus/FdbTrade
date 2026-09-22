-- R0.7 deterministic signal-intelligence and evidence authority.
CREATE TABLE signal_rule_registry (
  rule_id            TEXT NOT NULL,
  logic_version      TEXT NOT NULL,
  config_version     TEXT NOT NULL,
  config_json        TEXT NOT NULL,
  config_digest      TEXT NOT NULL CHECK(length(config_digest) = 64),
  registered_at_utc  TEXT NOT NULL,
  PRIMARY KEY(rule_id, logic_version, config_version)
) STRICT;

CREATE TABLE signal_evaluation_runs (
  run_id             TEXT PRIMARY KEY,
  dedup_key          TEXT NOT NULL UNIQUE,
  request_hash       TEXT NOT NULL CHECK(length(request_hash) = 64),
  dataset_id         TEXT NOT NULL REFERENCES market_data_datasets(dataset_id) ON DELETE RESTRICT,
  rule_id            TEXT NOT NULL,
  logic_version      TEXT NOT NULL,
  config_version     TEXT NOT NULL,
  assessed_at_utc    TEXT NOT NULL,
  status             TEXT NOT NULL CHECK(status IN ('pending', 'running', 'succeeded', 'blocked', 'failed')),
  attempts           INTEGER NOT NULL CHECK(attempts >= 0),
  evidence_id        TEXT,
  failure_reason     TEXT,
  created_at_utc     TEXT NOT NULL,
  updated_at_utc     TEXT NOT NULL,
  FOREIGN KEY(rule_id, logic_version, config_version)
    REFERENCES signal_rule_registry(rule_id, logic_version, config_version) ON DELETE RESTRICT,
  CHECK((status IN ('succeeded', 'blocked') AND evidence_id IS NOT NULL AND failure_reason IS NULL)
     OR (status = 'failed' AND evidence_id IS NULL AND failure_reason IS NOT NULL)
     OR (status IN ('pending', 'running') AND evidence_id IS NULL AND failure_reason IS NULL))
) STRICT;

CREATE TABLE signal_candidates (
  signal_id          TEXT PRIMARY KEY,
  dataset_id         TEXT NOT NULL REFERENCES market_data_datasets(dataset_id) ON DELETE RESTRICT,
  rule_id            TEXT NOT NULL,
  logic_version      TEXT NOT NULL,
  config_version     TEXT NOT NULL,
  instrument         TEXT NOT NULL CHECK(instrument IN (
                       'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF',
                       'AUDUSD', 'USDCAD', 'NZDUSD'
                     )),
  timeframe          TEXT NOT NULL CHECK(timeframe IN ('15m', '1h', '4h')),
  event_time_utc     TEXT NOT NULL,
  expires_at_utc     TEXT NOT NULL,
  direction          TEXT NOT NULL CHECK(direction IN ('long', 'short')),
  snapshot_hash      TEXT NOT NULL CHECK(length(snapshot_hash) = 64),
  signal_json        TEXT NOT NULL,
  created_at_utc     TEXT NOT NULL,
  FOREIGN KEY(rule_id, logic_version, config_version)
    REFERENCES signal_rule_registry(rule_id, logic_version, config_version) ON DELETE RESTRICT,
  UNIQUE(signal_id, dataset_id),
  CHECK(event_time_utc < expires_at_utc)
) STRICT;

CREATE INDEX signal_candidates_scope_idx
  ON signal_candidates(instrument, timeframe, event_time_utc);

CREATE TABLE signal_evidence (
  evidence_id        TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL UNIQUE REFERENCES signal_evaluation_runs(run_id) ON DELETE RESTRICT,
  dataset_id         TEXT NOT NULL REFERENCES market_data_datasets(dataset_id) ON DELETE RESTRICT,
  rule_id            TEXT NOT NULL,
  logic_version      TEXT NOT NULL,
  config_version     TEXT NOT NULL,
  outcome            TEXT NOT NULL CHECK(outcome IN ('candidate', 'wait', 'blocked')),
  signal_id          TEXT REFERENCES signal_candidates(signal_id) ON DELETE RESTRICT,
  evidence_digest    TEXT NOT NULL UNIQUE CHECK(length(evidence_digest) = 64),
  evidence_json      TEXT NOT NULL,
  created_at_utc     TEXT NOT NULL,
  FOREIGN KEY(rule_id, logic_version, config_version)
    REFERENCES signal_rule_registry(rule_id, logic_version, config_version) ON DELETE RESTRICT,
  FOREIGN KEY(signal_id, dataset_id)
    REFERENCES signal_candidates(signal_id, dataset_id) ON DELETE RESTRICT,
  CHECK((outcome = 'candidate' AND signal_id IS NOT NULL)
     OR (outcome IN ('wait', 'blocked') AND signal_id IS NULL))
) STRICT;

CREATE TABLE signal_lifecycle_events (
  event_id           TEXT PRIMARY KEY,
  signal_id          TEXT NOT NULL REFERENCES signal_candidates(signal_id) ON DELETE RESTRICT,
  state              TEXT NOT NULL CHECK(state IN ('identified', 'expired')),
  effective_at_utc   TEXT NOT NULL,
  reason             TEXT NOT NULL,
  created_at_utc     TEXT NOT NULL,
  UNIQUE(signal_id, state)
) STRICT;

CREATE TRIGGER signal_rule_registry_no_update
BEFORE UPDATE ON signal_rule_registry
BEGIN
  SELECT RAISE(ABORT, 'signal rule registry is immutable');
END;

CREATE TRIGGER signal_rule_registry_no_delete
BEFORE DELETE ON signal_rule_registry
BEGIN
  SELECT RAISE(ABORT, 'signal rule registry is immutable');
END;

CREATE TRIGGER signal_runs_terminal_immutable
BEFORE UPDATE ON signal_evaluation_runs
WHEN OLD.status IN ('succeeded', 'blocked', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'terminal signal evaluation runs are immutable');
END;

CREATE TRIGGER signal_runs_no_delete
BEFORE DELETE ON signal_evaluation_runs
BEGIN
  SELECT RAISE(ABORT, 'signal evaluation runs are append-only');
END;

CREATE TRIGGER signal_candidates_no_update
BEFORE UPDATE ON signal_candidates
BEGIN
  SELECT RAISE(ABORT, 'signal candidates are immutable');
END;

CREATE TRIGGER signal_candidates_no_delete
BEFORE DELETE ON signal_candidates
BEGIN
  SELECT RAISE(ABORT, 'signal candidates are immutable');
END;

CREATE TRIGGER signal_evidence_no_update
BEFORE UPDATE ON signal_evidence
BEGIN
  SELECT RAISE(ABORT, 'signal evidence is immutable');
END;

CREATE TRIGGER signal_evidence_no_delete
BEFORE DELETE ON signal_evidence
BEGIN
  SELECT RAISE(ABORT, 'signal evidence is append-only');
END;

CREATE TRIGGER signal_lifecycle_no_update
BEFORE UPDATE ON signal_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'signal lifecycle events are immutable');
END;

CREATE TRIGGER signal_lifecycle_no_delete
BEFORE DELETE ON signal_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'signal lifecycle events are append-only');
END;
