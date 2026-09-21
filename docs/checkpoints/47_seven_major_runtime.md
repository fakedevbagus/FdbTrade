# M47 Checkpoint — Seven-major runtime coverage

Status: complete; implementation commit `be3409c`; authority pin commit (this commit)

## Delivered

- `backend/src/runtime/sevenMajors.ts`: the configured seven-major runtime authority (`EUR_USD`, `GBP_USD`, `USD_JPY`, `USD_CHF`, `AUD_USD`, `USD_CAD`, `NZD_USD`) mapping provider pairs to canonical catalog instruments with base/quote currencies and currency clusters.
- Per-pair isolation: each pair owns its worker, job store and bounded cache (`SEVEN_MAJOR_CACHED_RANGES_PER_PAIR`), so one pair's failure cannot take unrelated pairs offline and cannot fabricate data.
- Pair projections carry measured `acceptedCandles`, measured `quarantinedRows` (from the P02-03 quality gate), `gaps`, `retries`, explicit `state` and `provenance: "fixture"`. Resource counters report configured/completed/failed/shed pairs, degradation level and the cache ceiling.
- Bounded load shedding reuses the M45 degradation vocabulary (`evaluateDegradation` + `admitCycle`); an explicit operator level can only raise degradation. Shed pairs are explicitly `unavailable` (`cycle_not_admitted:suspended`, `load_shed:observation_only`) with zero candles.
- Read-only pipeline: the dashboard snapshot/detail/chart slice now defaults to the seven configured majors and fails closed for any instrument outside it. Every overview row carries `configuredPair` + `provenance`.
- Dashboard pair filter: `GET /api/dashboard?pairs=...` (comma-separated configured pairs, configured order preserved, unknown/repeated pairs `400`); the UI derives chips/validation from one contract list, shows a per-pair provenance column, and hard-codes no pair state.

## Authority and safety

No durable state is added by M47: the projection is a pure function of (range, config, provider), so restart equals re-derivation. PostgreSQL/paper stores from earlier milestones remain the runtime authority; historical datasets stay under `FDB_HISTORICAL_DATASET_DIR`.

`LIVE_EXECUTION_ENABLED=false`; `PROVIDER_ORDER_TRANSPORT_ENABLED=false`; fixture-only provenance; no provider credential, no network access, no order/trade/position capability added. Risk hard limits (ADR-0022) and portfolio/currency-cluster authorities are untouched by shedding.

## Recovery

Re-run the replay after a restart; there is no M47 state to restore. If a pair is `unavailable`, inspect its reported reason (`outcome.job.failureReason`, `fault_injected_pair_unavailable`, or a shed reason) and re-request the same range — identical inputs reproduce identical output. Never substitute another pair's or fixture-derived bars for a missing pair.

## Evidence

`make seven-majors-check` (backend runtime/pipeline/dashboard-route suites, frontend dashboard client/component suites, Python M47 contracts). Performance/memory evidence: one fixture week across all seven pairs inside the fixed cache ceiling, recorded with the final gate results in `02_REPORTS/M47_COMPLETION_REPORT.md`.

Next authorized milestone: M48 — Credentialed read-only provider shadow. Do not begin in same agent run.
