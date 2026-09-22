-- R0.6 market-data and immutable artifact authority.
CREATE TABLE market_data_artifacts (
  digest          TEXT PRIMARY KEY CHECK(length(digest) = 64),
  relative_path   TEXT NOT NULL UNIQUE,
  byte_count      INTEGER NOT NULL CHECK(byte_count >= 0),
  media_type      TEXT NOT NULL CHECK(media_type = 'application/vnd.fdbtrade.candles'),
  created_at_utc  TEXT NOT NULL
) STRICT;

CREATE TABLE market_data_datasets (
  dataset_id           TEXT PRIMARY KEY,
  artifact_digest      TEXT NOT NULL REFERENCES market_data_artifacts(digest) ON DELETE RESTRICT,
  provider_id          TEXT NOT NULL,
  instrument           TEXT NOT NULL CHECK(instrument IN (
                         'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF',
                         'AUDUSD', 'USDCAD', 'NZDUSD'
                       )),
  timeframe            TEXT NOT NULL CHECK(timeframe IN ('15m', '1h', '4h')),
  source_mode          TEXT NOT NULL CHECK(source_mode IN ('fixture', 'historical')),
  period_start_utc     TEXT NOT NULL,
  period_end_utc       TEXT NOT NULL,
  record_count         INTEGER NOT NULL CHECK(record_count > 0),
  manifest_json        TEXT NOT NULL,
  quality_json         TEXT NOT NULL,
  accepted_count       INTEGER NOT NULL CHECK(accepted_count > 0),
  quarantined_count    INTEGER NOT NULL CHECK(quarantined_count >= 0),
  gap_count            INTEGER NOT NULL CHECK(gap_count >= 0),
  duplicate_count      INTEGER NOT NULL CHECK(duplicate_count >= 0),
  quality_state        TEXT NOT NULL CHECK(quality_state IN ('accepted', 'quarantined', 'gapped')),
  freshness_state      TEXT NOT NULL CHECK(freshness_state IN ('fresh', 'stale')),
  latest_bar_close_utc TEXT NOT NULL,
  assessed_at_utc      TEXT NOT NULL,
  created_at_utc       TEXT NOT NULL,
  CHECK(period_start_utc < period_end_utc),
  CHECK(accepted_count = record_count)
) STRICT;

CREATE INDEX market_data_datasets_scope_idx
  ON market_data_datasets(instrument, timeframe, period_start_utc, period_end_utc);

CREATE TABLE market_data_ingestion_jobs (
  job_id          TEXT PRIMARY KEY,
  dedup_key       TEXT NOT NULL UNIQUE,
  request_hash    TEXT NOT NULL CHECK(length(request_hash) = 64),
  status          TEXT NOT NULL CHECK(status IN ('pending', 'running', 'succeeded', 'failed')),
  attempts        INTEGER NOT NULL CHECK(attempts >= 0),
  dataset_id      TEXT REFERENCES market_data_datasets(dataset_id) ON DELETE RESTRICT,
  failure_reason  TEXT,
  created_at_utc  TEXT NOT NULL,
  updated_at_utc  TEXT NOT NULL,
  CHECK((status = 'succeeded' AND dataset_id IS NOT NULL AND failure_reason IS NULL)
     OR (status = 'failed' AND dataset_id IS NULL AND failure_reason IS NOT NULL)
     OR (status IN ('pending', 'running') AND dataset_id IS NULL AND failure_reason IS NULL))
) STRICT;

CREATE TRIGGER market_data_artifacts_no_update
BEFORE UPDATE ON market_data_artifacts
BEGIN
  SELECT RAISE(ABORT, 'market-data artifacts are immutable');
END;

CREATE TRIGGER market_data_artifacts_no_delete
BEFORE DELETE ON market_data_artifacts
BEGIN
  SELECT RAISE(ABORT, 'market-data artifacts are immutable');
END;

CREATE TRIGGER market_data_datasets_no_update
BEFORE UPDATE ON market_data_datasets
BEGIN
  SELECT RAISE(ABORT, 'market-data datasets are immutable');
END;

CREATE TRIGGER market_data_datasets_no_delete
BEFORE DELETE ON market_data_datasets
BEGIN
  SELECT RAISE(ABORT, 'market-data datasets are immutable');
END;

CREATE TRIGGER market_data_jobs_terminal_immutable
BEFORE UPDATE ON market_data_ingestion_jobs
WHEN OLD.status IN ('succeeded', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'terminal market-data ingestion jobs are immutable');
END;

CREATE TRIGGER market_data_jobs_no_delete
BEFORE DELETE ON market_data_ingestion_jobs
BEGIN
  SELECT RAISE(ABORT, 'market-data ingestion jobs are append-only');
END;
