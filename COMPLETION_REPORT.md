# Completion Report

Prompt ID: M47 — Seven-major runtime coverage
Phase: Phase 2 — Operational Private Beta 2.1
Date/time UTC: 2026-09-21T00:00:00Z
Branch/commit: main (`be3409c` implementation; authority pin commit (this commit))
Baseline commit: 2a3d651 (M46 authority pin)

## M47 summary

M47 expands the continuously running slice from the proven vertical pair to the
seven configured majors: `EUR_USD`, `GBP_USD`, `USD_JPY`, `USD_CHF`, `AUD_USD`,
`USD_CAD`, `NZD_USD`.

`backend/src/runtime/sevenMajors.ts` is the single runtime authority mapping
provider pairs to canonical instruments with currency clusters. Every pair owns
its own ingestion worker, job store and bounded cache, so one pair can fail
without inventing data or taking unrelated pairs offline. Pair projections carry
measured accepted/quarantined/gap/retry counts, an explicit state and fixture
provenance; quarantine counts come from the P02-03 gate through the additive
`IngestionResult.quarantined` field.

Resource boundedness is explicit: per-pair caches are capped, and bounded load
shedding reuses the M45 degradation vocabulary (`evaluateDegradation` +
`admitCycle`). The effective level is the more severe of measured pressure and
any explicit operator level, so a caller can raise degradation but never weaken
admission; shed pairs are `unavailable` with an explicit reason and zero candles.

The read-only signal pipeline now defaults to the seven configured majors and
fails closed for any instrument outside the slice. The dashboard gains a
pair-level filter (`GET /api/dashboard?pairs=...`, configured order preserved,
unknown/repeated pairs rejected with 400), per-pair provenance in the overview,
and filter chips derived from one contract list — no hard-coded pair state.

Safety unchanged: `LIVE_EXECUTION_ENABLED=false`,
`PROVIDER_ORDER_TRANSPORT_ENABLED=false`, loopback-only, paper-only, fixture-only
provenance, no provider credential or network access, no order/trade/position
capability. Risk hard limits and portfolio/currency-cluster authorities are
untouched by shedding.

## Evidence

- `make seven-majors-check` — backend 38 Vitest, frontend 24 Vitest, and 8 Python M47 contract tests pass.
- `make runtime-check`, `make operational-persistence-check`, `make integration-replay-check`, and `make historical-research-check` pass.
- `make lint`, `make typecheck`, `make format-check`, `make test`, and `make build` pass.
- `make operational-packaging-check`, `make private-beta-check`, `make dashboard-check`, `make security-check`, `make phase2-check`, and `make handoff-check` pass.
- `make test` totals: backend 676 tests / 71 files, frontend 97 tests / 12 files, contracts 631 tests / 43 files, Python 535 tests.

## Records

- ADR: `docs/adr/ADR-0036-seven-major-runtime-coverage.md`
- Checkpoint: `docs/checkpoints/47_seven_major_runtime.md`
- Detailed report: `02_REPORTS/M47_COMPLETION_REPORT.md`
- Next authorized milestone: M48 — Credentialed read-only provider shadow. Not started.

## Prior milestone archive

M46 historical-research evidence remains immutable in
`02_REPORTS/M46_COMPLETION_REPORT.md` and
`docs/checkpoints/46_historical_research.md`.
