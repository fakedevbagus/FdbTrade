-- R1.6 deterministic paper-input resolution authority.
CREATE TABLE paper_input_configs (
  config_id                 TEXT NOT NULL,
  config_version            TEXT NOT NULL,
  config_digest             TEXT NOT NULL CHECK(length(config_digest) = 64),
  config_json               TEXT NOT NULL,
  registered_at_utc         TEXT NOT NULL,
  PRIMARY KEY(config_id, config_version)
) STRICT;

CREATE TABLE paper_input_resolution_runs (
  resolution_run_id         TEXT PRIMARY KEY,
  dedup_key                 TEXT NOT NULL UNIQUE,
  request_hash              TEXT NOT NULL CHECK(length(request_hash) = 64),
  request_json              TEXT NOT NULL,
  signal_id                 TEXT NOT NULL,
  execution_dataset_id      TEXT NOT NULL,
  config_id                 TEXT NOT NULL,
  config_version            TEXT NOT NULL,
  config_digest             TEXT NOT NULL CHECK(length(config_digest) = 64),
  status                    TEXT NOT NULL CHECK(status IN ('pending', 'running', 'resolved', 'blocked')),
  attempts                  INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  resolution_id             TEXT UNIQUE,
  block_reason              TEXT CHECK(block_reason IN (
                              'signal_missing', 'signal_inactive', 'input_stale',
                              'signal_dataset_missing', 'execution_dataset_missing',
                              'signal_dataset_corrupt', 'execution_dataset_corrupt',
                              'dataset_quality_rejected', 'dataset_scope_mismatch',
                              'event_bar_missing', 'event_bar_ambiguous',
                              'config_drift'
                            )),
  created_at_utc            TEXT NOT NULL,
  updated_at_utc            TEXT NOT NULL,
  FOREIGN KEY(config_id, config_version)
    REFERENCES paper_input_configs(config_id, config_version) ON DELETE RESTRICT,
  CHECK((status IN ('pending', 'running') AND resolution_id IS NULL AND block_reason IS NULL)
     OR (status = 'resolved' AND resolution_id IS NOT NULL AND block_reason IS NULL)
     OR (status = 'blocked' AND resolution_id IS NULL AND block_reason IS NOT NULL))
) STRICT;

CREATE TABLE paper_input_resolutions (
  resolution_id             TEXT PRIMARY KEY,
  resolution_run_id         TEXT NOT NULL UNIQUE REFERENCES paper_input_resolution_runs(resolution_run_id) ON DELETE RESTRICT,
  signal_id                 TEXT NOT NULL REFERENCES signal_candidates(signal_id) ON DELETE RESTRICT,
  signal_dataset_id         TEXT NOT NULL REFERENCES market_data_datasets(dataset_id) ON DELETE RESTRICT,
  signal_artifact_digest    TEXT NOT NULL CHECK(length(signal_artifact_digest) = 64),
  execution_dataset_id      TEXT NOT NULL REFERENCES market_data_datasets(dataset_id) ON DELETE RESTRICT,
  execution_artifact_digest TEXT NOT NULL CHECK(length(execution_artifact_digest) = 64),
  event_time_utc            TEXT NOT NULL,
  checked_at_utc            TEXT NOT NULL,
  config_id                 TEXT NOT NULL,
  config_version            TEXT NOT NULL,
  config_digest             TEXT NOT NULL CHECK(length(config_digest) = 64),
  conversion_method         TEXT NOT NULL CHECK(conversion_method IN ('identity', 'inverse')),
  conversion_bar_digest     TEXT NOT NULL CHECK(length(conversion_bar_digest) = 64),
  resolution_digest         TEXT NOT NULL UNIQUE CHECK(length(resolution_digest) = 64),
  resolution_json           TEXT NOT NULL,
  created_at_utc            TEXT NOT NULL,
  FOREIGN KEY(config_id, config_version)
    REFERENCES paper_input_configs(config_id, config_version) ON DELETE RESTRICT
) STRICT;

CREATE INDEX paper_input_resolution_runs_signal_idx
  ON paper_input_resolution_runs(signal_id, created_at_utc);

CREATE TRIGGER paper_input_configs_no_update
BEFORE UPDATE ON paper_input_configs
BEGIN
  SELECT RAISE(ABORT, 'paper input configs are immutable');
END;

CREATE TRIGGER paper_input_configs_no_delete
BEFORE DELETE ON paper_input_configs
BEGIN
  SELECT RAISE(ABORT, 'paper input configs are immutable');
END;

CREATE TRIGGER paper_input_resolution_runs_terminal_immutable
BEFORE UPDATE ON paper_input_resolution_runs
WHEN OLD.status IN ('resolved', 'blocked')
BEGIN
  SELECT RAISE(ABORT, 'terminal paper input resolution runs are immutable');
END;

CREATE TRIGGER paper_input_resolution_runs_no_delete
BEFORE DELETE ON paper_input_resolution_runs
BEGIN
  SELECT RAISE(ABORT, 'paper input resolution runs are append-only');
END;

CREATE TRIGGER paper_input_resolutions_no_update
BEFORE UPDATE ON paper_input_resolutions
BEGIN
  SELECT RAISE(ABORT, 'paper input resolutions are immutable');
END;

CREATE TRIGGER paper_input_resolutions_no_delete
BEFORE DELETE ON paper_input_resolutions
BEGIN
  SELECT RAISE(ABORT, 'paper input resolutions are append-only');
END;
