# ADR-0036: Seven-major runtime coverage

- Status: Accepted
- Date: 2026-09-21
- Deciders: FdbTrade private-beta owner
- Supersedes: None
- Related: ADR-0003, ADR-0009, ADR-0010, ADR-0011, ADR-0012, ADR-0022, ADR-0027, ADR-0034
- Milestone: M47

## Context

The runtime slice was expressed as the whole instrument catalog (including XAUUSD) and the command center carried no pair-level identity or provenance. M47 must expand the continuously running slice to the seven configured majors with pair isolation, explicit provenance and bounded resource use, without adding any execution authority.

## Decision

`backend/src/runtime/sevenMajors.ts` is the single authority for the configured seven-major runtime: external provider pair ids (`EUR_USD`) map to canonical catalog instruments (`EURUSD`) with base/quote currencies and currency clusters.

- Each pair owns its own ingestion worker, job store and cache, bounded to `SEVEN_MAJOR_CACHED_RANGES_PER_PAIR` ranges, so one pair's failure cannot poison another pair's state and the slice has a fixed memory ceiling.
- Pair projections report measured `acceptedCandles`, measured `quarantinedRows` (from the P02-03 quality gate via the additive `IngestionResult.quarantined` field), `gaps`, `retries`, an explicit `state` (`fresh` / `stale` / `quarantined` / `unavailable`) and `provenance: "fixture"`. Failures never fabricate bars.
- Bounded load shedding reuses the M45 degradation vocabulary: `evaluateDegradation` derives a level from measured pressure and `admitCycle` decides the scope. The effective level is the MORE severe of the derived level and any explicit operator level — a caller can raise degradation but never weaken admission. A shed pair is explicitly `unavailable` with reason `cycle_not_admitted:suspended` or `load_shed:observation_only`, zero candles, and no substitution.
- `GET /api/dashboard` accepts an optional `pairs` filter (comma-separated configured pairs). Unknown, non-configured or repeated pairs fail closed with `400 VALIDATION_ERROR`; response order follows the configured pair order, never request order.
- The dashboard derives its filter chips and validation from one contract list (`CONFIGURED_PAIRS` in `frontend/src/lib/dashboard.ts`), shows each row's configured pair plus provenance, and hard-codes no per-pair operational state.
- The read-only signal pipeline (`buildDashboardSnapshot`, `buildSignalDetail`, `buildSignalChart`) uses the seven configured majors as its default slice and rejects any instrument outside it, so an unknown universe can never be improvised.
- No durable state is added: the projection is a pure function of (range, config, provider), so restart equals re-derivation. Risk hard limits, paper-only execution and existing portfolio/currency-cluster authorities are untouched.

## Consequences

- The operational slice is exactly the seven configured majors; XAUUSD and any other catalog instrument stay outside it until a later ADR widens the slice.
- Partial availability is visible and honest (per-pair state plus reasons) instead of a composite status hiding failures.
- Load shedding throttles observation intensity only; it never bypasses risk hard limits (ADR-0022) and never enables execution.
- The ingestion worker now exposes the P02-03 quarantine records it already measured, so downstream reports never invent a quarantine count.
- All M47 data is fixture provenance; no provider credential, shadow mode or network access is introduced.

## Verification

`pnpm --filter @fdbtrade/backend test src/runtime/__tests__/sevenMajors.test.ts` (11 behavior tests: pair identity, isolation, measured quarantine, suspended/observation-only admission, monotone degradation, restart reproducibility, crash recovery, bounded caches and performance evidence), the pipeline/dashboard suites, `pnpm --filter @fdbtrade/frontend test`, `make seven-majors-check`, and the M47 gate set recorded in `02_REPORTS/M47_COMPLETION_REPORT.md`.
