CREATE TABLE temporal_validation_configs (
  config_id                 TEXT NOT NULL,
  config_version            TEXT NOT NULL,
  config_digest             TEXT NOT NULL CHECK(length(config_digest) = 64),
  config_json               TEXT NOT NULL,
  research_config_id        TEXT NOT NULL,
  research_config_version   TEXT NOT NULL,
  registered_at_utc         TEXT NOT NULL,
  PRIMARY KEY(config_id, config_version),
  FOREIGN KEY(research_config_id, research_config_version)
    REFERENCES research_backtest_configs(config_id, config_version) ON DELETE RESTRICT
) STRICT;

CREATE TABLE temporal_validation_runs (
  authority_run_id     TEXT PRIMARY KEY,
  dedup_key            TEXT NOT NULL UNIQUE,
  request_hash         TEXT NOT NULL CHECK(length(request_hash) = 64),
  dataset_id           TEXT NOT NULL REFERENCES market_data_datasets(dataset_id) ON DELETE RESTRICT,
  config_id            TEXT NOT NULL,
  config_version       TEXT NOT NULL,
  status               TEXT NOT NULL CHECK(status IN ('pending', 'running', 'succeeded', 'blocked', 'failed')),
  attempts             INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  result_id            TEXT UNIQUE,
  failure_reason       TEXT,
  created_at_utc       TEXT NOT NULL,
  updated_at_utc       TEXT NOT NULL,
  FOREIGN KEY(config_id, config_version)
    REFERENCES temporal_validation_configs(config_id, config_version) ON DELETE RESTRICT,
  CHECK((status IN ('pending', 'running') AND result_id IS NULL AND failure_reason IS NULL)
     OR (status IN ('succeeded', 'blocked') AND result_id IS NOT NULL AND failure_reason IS NULL)
     OR (status = 'failed' AND result_id IS NULL AND failure_reason IS NOT NULL))
) STRICT;

CREATE INDEX temporal_validation_runs_dataset_idx
  ON temporal_validation_runs(dataset_id, created_at_utc);

CREATE TABLE temporal_validation_artifacts (
  digest          TEXT PRIMARY KEY CHECK(length(digest) = 64),
  relative_path   TEXT NOT NULL UNIQUE,
  byte_count      INTEGER NOT NULL CHECK(byte_count > 0),
  created_at_utc  TEXT NOT NULL
) STRICT;

CREATE TABLE temporal_validation_results (
  result_id                TEXT PRIMARY KEY,
  authority_run_id         TEXT NOT NULL UNIQUE REFERENCES temporal_validation_runs(authority_run_id) ON DELETE RESTRICT,
  dataset_id               TEXT NOT NULL REFERENCES market_data_datasets(dataset_id) ON DELETE RESTRICT,
  dataset_artifact_digest  TEXT NOT NULL CHECK(length(dataset_artifact_digest) = 64),
  config_digest            TEXT NOT NULL CHECK(length(config_digest) = 64),
  split_digest             TEXT NOT NULL CHECK(length(split_digest) = 64),
  walkforward_digest       TEXT NOT NULL CHECK(length(walkforward_digest) = 64),
  costs_digest             TEXT NOT NULL CHECK(length(costs_digest) = 64),
  deterministic_seed       TEXT NOT NULL,
  artifact_digest          TEXT NOT NULL REFERENCES temporal_validation_artifacts(digest) ON DELETE RESTRICT,
  summary_digest           TEXT NOT NULL CHECK(length(summary_digest) = 64),
  summary_json             TEXT NOT NULL,
  created_at_utc           TEXT NOT NULL
) STRICT;

CREATE TRIGGER temporal_validation_configs_no_update
BEFORE UPDATE ON temporal_validation_configs
BEGIN
  SELECT RAISE(ABORT, 'temporal validation configs are immutable');
END;

CREATE TRIGGER temporal_validation_configs_no_delete
BEFORE DELETE ON temporal_validation_configs
BEGIN
  SELECT RAISE(ABORT, 'temporal validation configs are immutable');
END;

CREATE TRIGGER temporal_validation_runs_terminal_immutable
BEFORE UPDATE ON temporal_validation_runs
WHEN OLD.status IN ('succeeded', 'blocked', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'terminal temporal validation runs are immutable');
END;

CREATE TRIGGER temporal_validation_runs_no_delete
BEFORE DELETE ON temporal_validation_runs
BEGIN
  SELECT RAISE(ABORT, 'temporal validation runs are append-only');
END;

CREATE TRIGGER temporal_validation_artifacts_no_update
BEFORE UPDATE ON temporal_validation_artifacts
BEGIN
  SELECT RAISE(ABORT, 'temporal validation artifacts are immutable');
END;

CREATE TRIGGER temporal_validation_artifacts_no_delete
BEFORE DELETE ON temporal_validation_artifacts
BEGIN
  SELECT RAISE(ABORT, 'temporal validation artifacts are immutable');
END;

CREATE TRIGGER temporal_validation_results_no_update
BEFORE UPDATE ON temporal_validation_results
BEGIN
  SELECT RAISE(ABORT, 'temporal validation results are immutable');
END;

CREATE TRIGGER temporal_validation_results_no_delete
BEFORE DELETE ON temporal_validation_results
BEGIN
  SELECT RAISE(ABORT, 'temporal validation results are append-only');
END;
