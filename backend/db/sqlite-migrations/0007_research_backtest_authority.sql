CREATE TABLE research_backtest_configs (
  config_id            TEXT NOT NULL,
  config_version       TEXT NOT NULL,
  config_digest        TEXT NOT NULL CHECK(length(config_digest) = 64),
  config_json          TEXT NOT NULL,
  rule_id              TEXT NOT NULL,
  rule_logic_version   TEXT NOT NULL,
  rule_config_version  TEXT NOT NULL,
  registered_at_utc    TEXT NOT NULL,
  PRIMARY KEY(config_id, config_version),
  FOREIGN KEY(rule_id, rule_logic_version, rule_config_version)
    REFERENCES signal_rule_registry(rule_id, logic_version, config_version) ON DELETE RESTRICT
) STRICT;

CREATE TABLE research_backtest_runs (
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
    REFERENCES research_backtest_configs(config_id, config_version) ON DELETE RESTRICT,
  CHECK((status IN ('pending', 'running') AND result_id IS NULL AND failure_reason IS NULL)
     OR (status IN ('succeeded', 'blocked') AND result_id IS NOT NULL AND failure_reason IS NULL)
     OR (status = 'failed' AND result_id IS NULL AND failure_reason IS NOT NULL))
) STRICT;

CREATE INDEX research_backtest_runs_dataset_idx
  ON research_backtest_runs(dataset_id, created_at_utc);

CREATE TABLE research_backtest_artifacts (
  digest          TEXT PRIMARY KEY CHECK(length(digest) = 64),
  relative_path   TEXT NOT NULL UNIQUE,
  byte_count      INTEGER NOT NULL CHECK(byte_count > 0),
  created_at_utc  TEXT NOT NULL
) STRICT;

CREATE TABLE research_backtest_results (
  result_id          TEXT PRIMARY KEY,
  authority_run_id   TEXT NOT NULL UNIQUE REFERENCES research_backtest_runs(authority_run_id) ON DELETE RESTRICT,
  engine_run_id      TEXT,
  dataset_id         TEXT NOT NULL REFERENCES market_data_datasets(dataset_id) ON DELETE RESTRICT,
  artifact_digest    TEXT NOT NULL REFERENCES research_backtest_artifacts(digest) ON DELETE RESTRICT,
  summary_digest     TEXT NOT NULL CHECK(length(summary_digest) = 64),
  summary_json       TEXT NOT NULL,
  created_at_utc     TEXT NOT NULL
) STRICT;

CREATE TRIGGER research_backtest_configs_no_update
BEFORE UPDATE ON research_backtest_configs
BEGIN
  SELECT RAISE(ABORT, 'research backtest configs are immutable');
END;

CREATE TRIGGER research_backtest_configs_no_delete
BEFORE DELETE ON research_backtest_configs
BEGIN
  SELECT RAISE(ABORT, 'research backtest configs are immutable');
END;

CREATE TRIGGER research_backtest_runs_terminal_immutable
BEFORE UPDATE ON research_backtest_runs
WHEN OLD.status IN ('succeeded', 'blocked', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'terminal research backtest runs are immutable');
END;

CREATE TRIGGER research_backtest_runs_no_delete
BEFORE DELETE ON research_backtest_runs
BEGIN
  SELECT RAISE(ABORT, 'research backtest runs are append-only');
END;

CREATE TRIGGER research_backtest_artifacts_no_update
BEFORE UPDATE ON research_backtest_artifacts
BEGIN
  SELECT RAISE(ABORT, 'research backtest artifacts are immutable');
END;

CREATE TRIGGER research_backtest_artifacts_no_delete
BEFORE DELETE ON research_backtest_artifacts
BEGIN
  SELECT RAISE(ABORT, 'research backtest artifacts are immutable');
END;

CREATE TRIGGER research_backtest_results_no_update
BEFORE UPDATE ON research_backtest_results
BEGIN
  SELECT RAISE(ABORT, 'research backtest results are immutable');
END;

CREATE TRIGGER research_backtest_results_no_delete
BEFORE DELETE ON research_backtest_results
BEGIN
  SELECT RAISE(ABORT, 'research backtest results are append-only');
END;
