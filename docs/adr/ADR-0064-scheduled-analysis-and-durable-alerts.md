# ADR-0064: Scheduled analysis and durable in-app alerts

- Status: Accepted
- Date: 2026-10-01
- Deciders: FdbTrade private operator
- Supersedes: observation-only production scheduler handlers
- Related: ADR-0034, ADR-0039, ADR-0040, ADR-0063
- Work unit: R1.18

## Context

R0.5 provided a single-process, leased and checkpointed scheduler whose
production handlers were observation-only. R1.17 made explicitly requested,
read-only Twelve Data ranges authoritative through R0.6, but did not schedule
them or connect them to R0.7.

## Decision

When and only when `FDB_RUNTIME_SCHEDULER=on`, the production runtime replaces
the ingest, analyze and emit observations with a bounded durable pipeline:

1. plan at most 42 unique instrument/timeframe/closed-bar work items;
2. claim one oldest item per scheduler cycle;
3. ingest it through `AuthoritativeTwelveDataIngestion`;
4. evaluate the resulting R0.6 dataset through
   `SignalIntelligenceAuthority`;
5. append one idempotent SQLite-backed in-app alert;
6. observe backlog and the latest durable risk state without mutating it.

All seven approved pairs and only 15m, 1h and 4h are planned. Session metadata
determines the latest complete bar; closed weekends create no new work.
Existing process locks, cycle leases, hash-chained checkpoints, dedupe,
bounded retries, degradation admission and graceful drain remain unchanged.

Migration 0013 owns the durable work queue, alert preferences and alert event
ledger. Alert identity is immutable and unique by decision/class. Delivery
failure never rolls back a signal. The current delivery remains no-op/in-app.

## Safety boundary

The pipeline imports no risk-paper authority and has no paper-run, broker,
order, fill, strategy-promotion or provider-order call. The only risk access
is a read of the latest `risk_state_events` row for visibility. Scheduler
configuration remains opt-in and off by default.

## Recovery

An interrupted ingest/analyze/emit status rewinds to the preceding durable
boundary. R0.6 and R0.7 recovery verify artifact/evidence integrity before
replay. Provider failures become explicit failed work; no fixture fallback or
partial authority is allowed.

## Consequences

- At most one provider-analysis unit is executed per cycle.
- Backlog pressure participates in existing scheduler degradation.
- In-app alert events and preferences survive restart.
- Real credentialed provider calls remain operator-controlled by enabling the
  scheduler and provisioning the existing mode-0600 secret file.

## Verification

Hermetic behavior tests cover successful stage chaining, duplicate replay,
restart at every stage boundary, provider outage, bounded backlog, durable
alert reopen and zero paper-table mutations. The complete toolchain gate
remains the final acceptance authority.