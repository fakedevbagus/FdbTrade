-- R0.5 local scheduler lifecycle authority.
-- Epoch milliseconds are used because scheduler leases compare monotonic UTC
-- observations supplied by the explicit runtime clock.
CREATE TABLE runtime_locks (
  lock_key         TEXT PRIMARY KEY,
  owner            TEXT NOT NULL,
  acquired_at_ms   INTEGER NOT NULL CHECK(acquired_at_ms >= 0),
  heartbeat_at_ms  INTEGER NOT NULL CHECK(heartbeat_at_ms >= acquired_at_ms),
  expires_at_ms    INTEGER NOT NULL CHECK(expires_at_ms >= heartbeat_at_ms)
) STRICT;

CREATE TABLE runtime_cycles (
  cycle_id            TEXT PRIMARY KEY,
  state               TEXT NOT NULL CHECK(state IN (
                        'pending', 'leased', 'running', 'committing',
                        'completed', 'timed_out', 'failed',
                        'shutdown_requested', 'shutdown_complete'
                      )),
  owner               TEXT NOT NULL,
  lease_expires_at_ms INTEGER NOT NULL CHECK(lease_expires_at_ms >= 0),
  heartbeat_at_ms     INTEGER NOT NULL CHECK(heartbeat_at_ms >= 0),
  attempts            INTEGER NOT NULL CHECK(attempts >= 0),
  max_attempts        INTEGER NOT NULL CHECK(max_attempts > 0),
  checkpoint_seq      INTEGER NOT NULL CHECK(checkpoint_seq >= 0),
  updated_at_ms       INTEGER NOT NULL CHECK(updated_at_ms >= 0)
) STRICT;

CREATE INDEX runtime_cycles_state_updated_idx
  ON runtime_cycles(state, updated_at_ms);

CREATE TABLE runtime_checkpoints (
  cycle_id   TEXT NOT NULL REFERENCES runtime_cycles(cycle_id) ON DELETE RESTRICT,
  seq        INTEGER NOT NULL CHECK(seq > 0),
  stage      TEXT NOT NULL,
  at_ms      INTEGER NOT NULL CHECK(at_ms >= 0),
  digest     TEXT,
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL CHECK(length(hash) = 64),
  PRIMARY KEY(cycle_id, seq)
) STRICT;

CREATE TABLE runtime_completions (
  cycle_id        TEXT PRIMARY KEY REFERENCES runtime_cycles(cycle_id) ON DELETE RESTRICT,
  outcome_hash    TEXT NOT NULL CHECK(length(outcome_hash) = 64),
  completed_at_ms INTEGER NOT NULL CHECK(completed_at_ms >= 0)
) STRICT;

CREATE TABLE runtime_dedupe (
  domain           TEXT NOT NULL CHECK(domain IN (
                     'cycle', 'job', 'outbox_event', 'paper_order', 'fill'
                   )),
  dedupe_key       TEXT NOT NULL,
  first_seen_at_ms INTEGER NOT NULL CHECK(first_seen_at_ms >= 0),
  content_hash     TEXT NOT NULL CHECK(length(content_hash) = 64),
  PRIMARY KEY(domain, dedupe_key)
) STRICT;
