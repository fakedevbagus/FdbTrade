-- R0.9 durable risk, paper-broker and operational-outcome authority.
CREATE TABLE risk_paper_configs (
  config_id          TEXT NOT NULL,
  config_version     TEXT NOT NULL,
  config_digest      TEXT NOT NULL CHECK(length(config_digest) = 64),
  config_json        TEXT NOT NULL,
  registered_at_utc  TEXT NOT NULL,
  PRIMARY KEY(config_id, config_version)
) STRICT;

CREATE TABLE risk_state_events (
  event_id            TEXT PRIMARY KEY,
  sequence_no         INTEGER NOT NULL UNIQUE CHECK(sequence_no >= 1),
  previous_state      TEXT CHECK(previous_state IN ('green', 'yellow', 'orange', 'red', 'kill')),
  state               TEXT NOT NULL CHECK(state IN ('green', 'yellow', 'orange', 'red', 'kill')),
  action              TEXT NOT NULL CHECK(action IN ('initialized', 'engage_kill', 'release_kill', 'force_state')),
  override_id         TEXT UNIQUE,
  actor               TEXT NOT NULL,
  reason              TEXT NOT NULL,
  effective_at_utc    TEXT NOT NULL,
  created_at_utc      TEXT NOT NULL,
  CHECK((sequence_no = 1 AND previous_state IS NULL AND action = 'initialized' AND state = 'green' AND override_id IS NULL)
     OR (sequence_no > 1 AND previous_state IS NOT NULL AND action <> 'initialized' AND override_id IS NOT NULL)),
  CHECK(action <> 'engage_kill' OR state = 'kill'),
  CHECK(action <> 'release_kill' OR previous_state = 'kill'),
  CHECK(action <> 'release_kill' OR state <> 'kill')
) STRICT;

CREATE TABLE risk_paper_runs (
  run_id               TEXT PRIMARY KEY,
  signal_id            TEXT NOT NULL UNIQUE REFERENCES signal_candidates(signal_id) ON DELETE RESTRICT,
  execution_dataset_id TEXT NOT NULL REFERENCES market_data_datasets(dataset_id) ON DELETE RESTRICT,
  request_hash         TEXT NOT NULL CHECK(length(request_hash) = 64),
  request_json         TEXT NOT NULL,
  risk_state_event_id  TEXT NOT NULL REFERENCES risk_state_events(event_id) ON DELETE RESTRICT,
  status               TEXT NOT NULL CHECK(status IN ('pending', 'running', 'succeeded', 'blocked', 'failed')),
  attempts             INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  risk_decision_id     TEXT UNIQUE,
  order_id             TEXT UNIQUE,
  outcome_id           TEXT UNIQUE,
  failure_reason       TEXT,
  created_at_utc       TEXT NOT NULL,
  updated_at_utc       TEXT NOT NULL,
  CHECK((status IN ('pending', 'running') AND order_id IS NULL AND outcome_id IS NULL AND failure_reason IS NULL)
     OR (status = 'succeeded' AND risk_decision_id IS NOT NULL AND order_id IS NOT NULL AND outcome_id IS NOT NULL AND failure_reason IS NULL)
     OR (status = 'blocked' AND risk_decision_id IS NOT NULL AND order_id IS NOT NULL AND outcome_id IS NULL AND failure_reason IS NULL)
     OR (status = 'failed' AND outcome_id IS NULL AND failure_reason IS NOT NULL))
) STRICT;

CREATE TABLE risk_decisions (
  decision_id          TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL UNIQUE REFERENCES risk_paper_runs(run_id) ON DELETE RESTRICT,
  signal_id            TEXT NOT NULL UNIQUE REFERENCES signal_candidates(signal_id) ON DELETE RESTRICT,
  risk_state_event_id  TEXT NOT NULL REFERENCES risk_state_events(event_id) ON DELETE RESTRICT,
  outcome              TEXT NOT NULL CHECK(outcome IN ('approved', 'rejected')),
  request_digest       TEXT NOT NULL,
  request_json         TEXT NOT NULL,
  decision_digest      TEXT NOT NULL UNIQUE CHECK(length(decision_digest) = 64),
  decision_json        TEXT NOT NULL,
  checked_at_utc       TEXT NOT NULL,
  created_at_utc       TEXT NOT NULL
) STRICT;

CREATE TABLE paper_orders (
  order_id             TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL UNIQUE REFERENCES risk_paper_runs(run_id) ON DELETE RESTRICT,
  signal_id            TEXT NOT NULL UNIQUE REFERENCES signal_candidates(signal_id) ON DELETE RESTRICT,
  risk_decision_id     TEXT NOT NULL UNIQUE REFERENCES risk_decisions(decision_id) ON DELETE RESTRICT,
  instrument           TEXT NOT NULL CHECK(instrument IN (
                         'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF',
                         'AUDUSD', 'USDCAD', 'NZDUSD'
                       )),
  timeframe            TEXT NOT NULL CHECK(timeframe IN ('15m', '1h', '4h')),
  direction            TEXT NOT NULL CHECK(direction IN ('long', 'short')),
  order_digest         TEXT NOT NULL UNIQUE CHECK(length(order_digest) = 64),
  order_json           TEXT NOT NULL,
  created_at_utc       TEXT NOT NULL
) STRICT;

CREATE TABLE paper_order_events (
  event_id             TEXT PRIMARY KEY,
  order_id             TEXT NOT NULL REFERENCES paper_orders(order_id) ON DELETE RESTRICT,
  sequence_no          INTEGER NOT NULL CHECK(sequence_no >= 1),
  event_type           TEXT NOT NULL CHECK(event_type IN (
                         'order_created', 'order_risk_checked', 'order_rejected',
                         'order_submitted', 'order_acknowledged', 'fill_executed',
                         'order_cancelled', 'order_expired', 'position_opened',
                         'position_managed', 'position_closed', 'broker_error'
                       )),
  effective_at_utc     TEXT NOT NULL,
  event_digest         TEXT NOT NULL UNIQUE CHECK(length(event_digest) = 64),
  event_json           TEXT NOT NULL,
  created_at_utc       TEXT NOT NULL,
  UNIQUE(order_id, sequence_no)
) STRICT;

CREATE TABLE paper_fills (
  fill_id              TEXT PRIMARY KEY,
  order_id             TEXT NOT NULL REFERENCES paper_orders(order_id) ON DELETE RESTRICT,
  sequence_no          INTEGER NOT NULL CHECK(sequence_no >= 1),
  side                 TEXT NOT NULL CHECK(side IN ('entry', 'exit')),
  effective_at_utc     TEXT NOT NULL,
  fill_digest          TEXT NOT NULL UNIQUE CHECK(length(fill_digest) = 64),
  fill_json            TEXT NOT NULL,
  context_json         TEXT NOT NULL,
  created_at_utc       TEXT NOT NULL,
  UNIQUE(order_id, sequence_no)
) STRICT;

CREATE TABLE paper_position_events (
  position_event_id    TEXT PRIMARY KEY,
  position_id          TEXT NOT NULL,
  order_id             TEXT NOT NULL REFERENCES paper_orders(order_id) ON DELETE RESTRICT,
  event_type           TEXT NOT NULL CHECK(event_type IN ('opened', 'closed')),
  effective_at_utc     TEXT NOT NULL,
  position_digest      TEXT NOT NULL UNIQUE CHECK(length(position_digest) = 64),
  position_json        TEXT NOT NULL,
  created_at_utc       TEXT NOT NULL,
  UNIQUE(position_id, event_type)
) STRICT;

CREATE TABLE paper_reconciliation_reports (
  reconciliation_id   TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL UNIQUE REFERENCES risk_paper_runs(run_id) ON DELETE RESTRICT,
  ok                   INTEGER NOT NULL CHECK(ok IN (0, 1)),
  report_digest        TEXT NOT NULL UNIQUE CHECK(length(report_digest) = 64),
  report_json          TEXT NOT NULL,
  reconciled_at_utc    TEXT NOT NULL,
  created_at_utc       TEXT NOT NULL
) STRICT;

CREATE TABLE paper_outcomes (
  outcome_id           TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL UNIQUE REFERENCES risk_paper_runs(run_id) ON DELETE RESTRICT,
  signal_id            TEXT NOT NULL UNIQUE REFERENCES signal_candidates(signal_id) ON DELETE RESTRICT,
  risk_decision_id     TEXT NOT NULL UNIQUE REFERENCES risk_decisions(decision_id) ON DELETE RESTRICT,
  order_id             TEXT NOT NULL UNIQUE REFERENCES paper_orders(order_id) ON DELETE RESTRICT,
  position_id          TEXT NOT NULL UNIQUE,
  outcome_digest       TEXT NOT NULL UNIQUE CHECK(length(outcome_digest) = 64),
  outcome_json         TEXT NOT NULL,
  closed_at_utc        TEXT NOT NULL,
  created_at_utc       TEXT NOT NULL
) STRICT;

CREATE TABLE paper_outcome_attribution_reports (
  report_id            TEXT PRIMARY KEY,
  through_outcome_id   TEXT NOT NULL UNIQUE REFERENCES paper_outcomes(outcome_id) ON DELETE RESTRICT,
  report_digest        TEXT NOT NULL UNIQUE CHECK(length(report_digest) = 64),
  report_json          TEXT NOT NULL,
  created_at_utc       TEXT NOT NULL
) STRICT;

CREATE TRIGGER risk_state_sequence_guard
BEFORE INSERT ON risk_state_events
WHEN NEW.sequence_no > 1
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM risk_state_events
    WHERE sequence_no = NEW.sequence_no - 1 AND state = NEW.previous_state
  ) THEN RAISE(ABORT, 'risk state events must extend the current state') END;
END;

CREATE TRIGGER paper_order_requires_risk_decision
BEFORE INSERT ON paper_orders
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM risk_decisions AS d
    WHERE d.decision_id = NEW.risk_decision_id
      AND d.run_id = NEW.run_id
      AND d.signal_id = NEW.signal_id
  ) THEN RAISE(ABORT, 'paper order requires its persisted risk decision') END;
END;

CREATE TRIGGER paper_execution_requires_approval
BEFORE INSERT ON paper_order_events
WHEN NEW.event_type IN ('order_submitted', 'order_acknowledged', 'fill_executed', 'position_opened', 'position_managed', 'position_closed')
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM paper_orders AS o
    JOIN risk_decisions AS d ON d.decision_id = o.risk_decision_id
    WHERE o.order_id = NEW.order_id AND d.outcome = 'approved'
  ) THEN RAISE(ABORT, 'paper execution requires an approved risk decision') END;
END;

CREATE TRIGGER paper_fill_requires_approval
BEFORE INSERT ON paper_fills
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM paper_orders AS o
    JOIN risk_decisions AS d ON d.decision_id = o.risk_decision_id
    WHERE o.order_id = NEW.order_id AND d.outcome = 'approved'
  ) THEN RAISE(ABORT, 'paper fill requires an approved risk decision') END;
END;

CREATE TRIGGER paper_outcome_requires_closed_position
BEFORE INSERT ON paper_outcomes
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM paper_position_events AS p
    WHERE p.position_id = NEW.position_id AND p.order_id = NEW.order_id AND p.event_type = 'closed'
  ) THEN RAISE(ABORT, 'paper outcome requires a closed paper position') END;
END;

CREATE TRIGGER risk_paper_runs_terminal_immutable
BEFORE UPDATE ON risk_paper_runs
WHEN OLD.status IN ('succeeded', 'blocked', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'terminal risk paper runs are immutable');
END;

CREATE TRIGGER risk_paper_configs_no_update BEFORE UPDATE ON risk_paper_configs BEGIN SELECT RAISE(ABORT, 'risk paper configs are immutable'); END;
CREATE TRIGGER risk_paper_configs_no_delete BEFORE DELETE ON risk_paper_configs BEGIN SELECT RAISE(ABORT, 'risk paper configs are immutable'); END;
CREATE TRIGGER risk_state_events_no_update BEFORE UPDATE ON risk_state_events BEGIN SELECT RAISE(ABORT, 'risk state events are immutable'); END;
CREATE TRIGGER risk_state_events_no_delete BEFORE DELETE ON risk_state_events BEGIN SELECT RAISE(ABORT, 'risk state events are append-only'); END;
CREATE TRIGGER risk_paper_runs_no_delete BEFORE DELETE ON risk_paper_runs BEGIN SELECT RAISE(ABORT, 'risk paper runs are append-only'); END;
CREATE TRIGGER risk_decisions_no_update BEFORE UPDATE ON risk_decisions BEGIN SELECT RAISE(ABORT, 'risk decisions are immutable'); END;
CREATE TRIGGER risk_decisions_no_delete BEFORE DELETE ON risk_decisions BEGIN SELECT RAISE(ABORT, 'risk decisions are append-only'); END;
CREATE TRIGGER paper_orders_no_update BEFORE UPDATE ON paper_orders BEGIN SELECT RAISE(ABORT, 'paper orders are immutable'); END;
CREATE TRIGGER paper_orders_no_delete BEFORE DELETE ON paper_orders BEGIN SELECT RAISE(ABORT, 'paper orders are append-only'); END;
CREATE TRIGGER paper_order_events_no_update BEFORE UPDATE ON paper_order_events BEGIN SELECT RAISE(ABORT, 'paper order events are immutable'); END;
CREATE TRIGGER paper_order_events_no_delete BEFORE DELETE ON paper_order_events BEGIN SELECT RAISE(ABORT, 'paper order events are append-only'); END;
CREATE TRIGGER paper_fills_no_update BEFORE UPDATE ON paper_fills BEGIN SELECT RAISE(ABORT, 'paper fills are immutable'); END;
CREATE TRIGGER paper_fills_no_delete BEFORE DELETE ON paper_fills BEGIN SELECT RAISE(ABORT, 'paper fills are append-only'); END;
CREATE TRIGGER paper_position_events_no_update BEFORE UPDATE ON paper_position_events BEGIN SELECT RAISE(ABORT, 'paper position events are immutable'); END;
CREATE TRIGGER paper_position_events_no_delete BEFORE DELETE ON paper_position_events BEGIN SELECT RAISE(ABORT, 'paper position events are append-only'); END;
CREATE TRIGGER paper_reconciliation_no_update BEFORE UPDATE ON paper_reconciliation_reports BEGIN SELECT RAISE(ABORT, 'paper reconciliation reports are immutable'); END;
CREATE TRIGGER paper_reconciliation_no_delete BEFORE DELETE ON paper_reconciliation_reports BEGIN SELECT RAISE(ABORT, 'paper reconciliation reports are append-only'); END;
CREATE TRIGGER paper_outcomes_no_update BEFORE UPDATE ON paper_outcomes BEGIN SELECT RAISE(ABORT, 'paper outcomes are immutable'); END;
CREATE TRIGGER paper_outcomes_no_delete BEFORE DELETE ON paper_outcomes BEGIN SELECT RAISE(ABORT, 'paper outcomes are append-only'); END;
CREATE TRIGGER paper_attribution_no_update BEFORE UPDATE ON paper_outcome_attribution_reports BEGIN SELECT RAISE(ABORT, 'paper attribution reports are immutable'); END;
CREATE TRIGGER paper_attribution_no_delete BEFORE DELETE ON paper_outcome_attribution_reports BEGIN SELECT RAISE(ABORT, 'paper attribution reports are append-only'); END;
