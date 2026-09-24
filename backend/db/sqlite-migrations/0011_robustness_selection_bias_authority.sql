CREATE TABLE robustness_experiment_configs (
  config_id                    TEXT NOT NULL,
  config_version               TEXT NOT NULL,
  config_digest                TEXT NOT NULL CHECK(length(config_digest) = 64),
  config_json                  TEXT NOT NULL,
  temporal_config_id           TEXT NOT NULL,
  temporal_config_version      TEXT NOT NULL,
  registered_at_utc            TEXT NOT NULL,
  PRIMARY KEY(config_id, config_version),
  FOREIGN KEY(temporal_config_id, temporal_config_version)
    REFERENCES temporal_validation_configs(config_id, config_version) ON DELETE RESTRICT
) STRICT;

CREATE TABLE robustness_experiment_runs (
  experiment_run_id       TEXT PRIMARY KEY,
  dedup_key               TEXT NOT NULL UNIQUE,
  request_hash            TEXT NOT NULL CHECK(length(request_hash) = 64),
  temporal_run_id         TEXT NOT NULL REFERENCES temporal_validation_runs(authority_run_id) ON DELETE RESTRICT,
  config_id               TEXT NOT NULL,
  config_version          TEXT NOT NULL,
  trial_plan_digest       TEXT NOT NULL CHECK(length(trial_plan_digest) = 64),
  status                  TEXT NOT NULL CHECK(status IN (
                            'pending', 'running', 'pass',
                            'insufficient-evidence', 'rejected', 'failed'
                          )),
  attempts                INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  result_id               TEXT UNIQUE,
  failure_reason          TEXT,
  created_at_utc          TEXT NOT NULL,
  updated_at_utc          TEXT NOT NULL,
  FOREIGN KEY(config_id, config_version)
    REFERENCES robustness_experiment_configs(config_id, config_version) ON DELETE RESTRICT,
  CHECK((status IN ('pending', 'running') AND result_id IS NULL AND failure_reason IS NULL)
     OR (status IN ('pass', 'insufficient-evidence', 'rejected') AND result_id IS NOT NULL AND failure_reason IS NULL)
     OR (status = 'failed' AND result_id IS NULL AND failure_reason IS NOT NULL))
) STRICT;

CREATE INDEX robustness_experiment_runs_temporal_idx
  ON robustness_experiment_runs(temporal_run_id, created_at_utc);

CREATE TABLE robustness_experiment_trials (
  experiment_run_id       TEXT NOT NULL REFERENCES robustness_experiment_runs(experiment_run_id) ON DELETE RESTRICT,
  trial_id                 TEXT NOT NULL,
  ordinal                  INTEGER NOT NULL CHECK(ordinal >= 0),
  declaration_digest      TEXT NOT NULL CHECK(length(declaration_digest) = 64),
  declaration_json        TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK(status IN ('declared', 'completed')),
  result_digest            TEXT CHECK(result_digest IS NULL OR length(result_digest) = 64),
  result_json              TEXT,
  completed_at_utc         TEXT,
  PRIMARY KEY(experiment_run_id, trial_id),
  UNIQUE(experiment_run_id, ordinal),
  CHECK((status = 'declared' AND result_digest IS NULL AND result_json IS NULL AND completed_at_utc IS NULL)
     OR (status = 'completed' AND result_digest IS NOT NULL AND result_json IS NOT NULL AND completed_at_utc IS NOT NULL))
) STRICT;

CREATE TABLE robustness_experiment_artifacts (
  digest          TEXT PRIMARY KEY CHECK(length(digest) = 64),
  relative_path   TEXT NOT NULL UNIQUE,
  byte_count      INTEGER NOT NULL CHECK(byte_count > 0),
  created_at_utc  TEXT NOT NULL
) STRICT;

CREATE TABLE robustness_experiment_results (
  result_id                TEXT PRIMARY KEY,
  experiment_run_id        TEXT NOT NULL UNIQUE REFERENCES robustness_experiment_runs(experiment_run_id) ON DELETE RESTRICT,
  temporal_run_id          TEXT NOT NULL REFERENCES temporal_validation_runs(authority_run_id) ON DELETE RESTRICT,
  temporal_artifact_digest TEXT NOT NULL CHECK(length(temporal_artifact_digest) = 64),
  dataset_artifact_digest  TEXT NOT NULL CHECK(length(dataset_artifact_digest) = 64),
  config_digest            TEXT NOT NULL CHECK(length(config_digest) = 64),
  trial_plan_digest        TEXT NOT NULL CHECK(length(trial_plan_digest) = 64),
  completed_trial_count    INTEGER NOT NULL CHECK(completed_trial_count > 0),
  conclusion               TEXT NOT NULL CHECK(conclusion IN ('pass', 'insufficient-evidence', 'rejected')),
  limitations_json         TEXT NOT NULL,
  artifact_digest          TEXT NOT NULL REFERENCES robustness_experiment_artifacts(digest) ON DELETE RESTRICT,
  summary_digest           TEXT NOT NULL CHECK(length(summary_digest) = 64),
  summary_json             TEXT NOT NULL,
  created_at_utc           TEXT NOT NULL
) STRICT;

CREATE TRIGGER robustness_experiment_configs_no_update
BEFORE UPDATE ON robustness_experiment_configs
BEGIN
  SELECT RAISE(ABORT, 'robustness experiment configs are immutable');
END;

CREATE TRIGGER robustness_experiment_configs_no_delete
BEFORE DELETE ON robustness_experiment_configs
BEGIN
  SELECT RAISE(ABORT, 'robustness experiment configs are immutable');
END;

CREATE TRIGGER robustness_experiment_runs_terminal_immutable
BEFORE UPDATE ON robustness_experiment_runs
WHEN OLD.status IN ('pass', 'insufficient-evidence', 'rejected', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'terminal robustness experiment runs are immutable');
END;

CREATE TRIGGER robustness_experiment_runs_no_delete
BEFORE DELETE ON robustness_experiment_runs
BEGIN
  SELECT RAISE(ABORT, 'robustness experiment runs are append-only');
END;

CREATE TRIGGER robustness_experiment_trials_completed_immutable
BEFORE UPDATE ON robustness_experiment_trials
WHEN OLD.status = 'completed'
BEGIN
  SELECT RAISE(ABORT, 'completed robustness experiment trials are immutable');
END;

CREATE TRIGGER robustness_experiment_trials_no_delete
BEFORE DELETE ON robustness_experiment_trials
BEGIN
  SELECT RAISE(ABORT, 'robustness experiment trials are append-only');
END;

CREATE TRIGGER robustness_experiment_artifacts_no_update
BEFORE UPDATE ON robustness_experiment_artifacts
BEGIN
  SELECT RAISE(ABORT, 'robustness experiment artifacts are immutable');
END;

CREATE TRIGGER robustness_experiment_artifacts_no_delete
BEFORE DELETE ON robustness_experiment_artifacts
BEGIN
  SELECT RAISE(ABORT, 'robustness experiment artifacts are immutable');
END;

CREATE TRIGGER robustness_experiment_results_no_update
BEFORE UPDATE ON robustness_experiment_results
BEGIN
  SELECT RAISE(ABORT, 'robustness experiment results are immutable');
END;

CREATE TRIGGER robustness_experiment_results_no_delete
BEFORE DELETE ON robustness_experiment_results
BEGIN
  SELECT RAISE(ABORT, 'robustness experiment results are append-only');
END;
