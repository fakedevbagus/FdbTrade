# M47 Completion Report — Seven-major runtime coverage

- Milestone: M47 — Seven-major runtime coverage
- Depends on: M46 (`7877e53`)
- Date: 2026-09-21
- Blueprint: `POST_PHASE2_BLUEPRINT_PROMPT_PACK.md` §5 M47

## Objective

Expand the continuously running slice from the proven vertical pair to the seven
configured majors without weakening isolation or safety.

## Delivered

| Area | Change |
| --- | --- |
| Runtime authority | `backend/src/runtime/sevenMajors.ts` — `SEVEN_MAJOR_PAIRS` / `SEVEN_MAJOR_CONFIG` map provider pairs (`EUR_USD`) to canonical instruments (`EURUSD`) with base/quote currencies and currency clusters. |
| Pair isolation | Each pair owns its own ingestion worker, job store and cache; `replaySevenMajors` reports per-pair `state`, `acceptedCandles`, `quarantinedRows`, `gaps`, `retries`, `error`, `provenance`. |
| Bounded resources | `SEVEN_MAJOR_CACHED_RANGES_PER_PAIR = 2` fixes the slice cache ceiling; `resources.maxCachedRanges` = pairs × ranges. |
| Bounded load shedding | Reuses M45 `evaluateDegradation` + `admitCycle`; effective level is the more severe of measured pressure and any explicit level. Shed pairs are explicitly `unavailable` with `cycle_not_admitted:suspended` / `load_shed:observation_only` and zero candles. |
| Measured quarantine | `IngestionResult.quarantined` (additive) exposes the P02-03 quarantine records the worker already measured; per-pair counts are never invented. |
| Read-only pipeline slice | `buildDashboardSnapshot`, `buildSignalDetail`, `buildSignalChart` default to the seven configured majors and reject any instrument outside the slice (`instrument is outside the configured seven-major runtime`). Overview rows carry `configuredPair` + `provenance`. |
| Dashboard filter | `GET /api/dashboard?pairs=EUR_USD[,USD_JPY...]` — configured pairs only, configured order preserved, unknown/repeated/out-of-range filters fail closed with `400 VALIDATION_ERROR`. |
| Dashboard UI | Pair filter chips + per-pair provenance column; chips and validation derive from one contract list (`CONFIGURED_PAIRS`); no hard-coded operational pair state. |

## Acceptance criteria mapping

| Blueprint acceptance | Evidence |
| --- | --- |
| Full seven-major fixture replay | `sevenMajors.test.ts` — 7 pairs, all fresh, fixture provenance, byte-identical re-runs. |
| Seven-major restart and crash recovery | Restart: independent re-run is byte-identical (no durable state added). Recovery: a fault-injected pair failure does not poison the next replay. |
| Pair-isolation fault injection | Injected failure keeps the other six pairs fresh with `completedPairs: 6, failedPairs: 1`; a duplicated bar quarantines only its own pair. |
| Performance and memory evidence | One fixture week × seven pairs inside the fixed cache ceiling (`maxCachedRanges = 14`); suite durations recorded below. |
| No hard-coded operational pair state in the UI | UI derives chips/validation from `CONFIGURED_PAIRS`; row state/provenance comes from the snapshot; unknown `?pairs=` renders an explicit error. |
| Dashboard filters and pair-level provenance | API `pairs` filter tests (narrow, configured order, unknown 400, repeated 400, default seven) + overview row `configuredPair`/`provenance` assertions in backend and frontend suites. |
| Portfolio exposure and currency-cluster limits remain authoritative | No risk/execution/paper module is imported by the M47 runtime; risk hard limits untouched (ADR-0022); shedding only throttles observation. |

## Safety invariants (unchanged)

- `LIVE_EXECUTION_ENABLED=false`, `PROVIDER_ORDER_TRANSPORT_ENABLED=false`.
- Fixture-only provenance in M47 (`provenance: "fixture"`); no provider credential, no network, no shadow mode.
- No order/trade/position capability added anywhere in the M47 surface.
- Loopback-only, paper-only, scheduler still off by default.

## Files

Implementation:

- `backend/src/runtime/sevenMajors.ts` (new)
- `backend/src/runtime/__tests__/sevenMajors.test.ts` (new)
- `backend/src/signals/pipeline.ts` (seven-major default slice, fail-closed boundary, pair provenance)
- `backend/src/app/api/dashboard/route.ts` (`pairs` filter)
- `backend/src/data/ingestion/worker.ts` (additive measured quarantine exposure)
- `frontend/src/lib/dashboard.ts` (`configuredPairSchema`, `CONFIGURED_PAIRS`, pair-aware fetch)
- `frontend/src/app/(app)/dashboard/page.tsx` (pair filter chips, fail-closed filter validation)
- `frontend/src/components/dashboard/DashboardContent.tsx` (pair + provenance columns)
- Tests updated: `backend/src/signals/__tests__/pipeline.test.ts`, `backend/src/app/api/dashboard/__tests__/route.test.ts`, `frontend/src/lib/__tests__/dashboard.test.ts`, `frontend/src/components/dashboard/__tests__/DashboardContent.test.tsx`

Governance:

- `docs/adr/ADR-0036-seven-major-runtime-coverage.md`
- `docs/adr/README.md`, `tests/test_ci_contracts.py` (ADR registry)
- `tests/test_m47_seven_major_contracts.py` (8 contract tests)
- `Makefile` — `make seven-majors-check`
- `docs/checkpoints/47_seven_major_runtime.md`

## Full gate record (2026-09-21, exit 0 for every gate)

| Gate | Result |
| --- | --- |
| `make lint` | EXIT:0 |
| `make typecheck` | EXIT:0 |
| `make format-check` | EXIT:0 |
| `make test` | EXIT:0 — backend 676 tests / 71 files, frontend 97 tests / 12 files, contracts 631 tests / 43 files, Python 535 tests |
| `make build` | EXIT:0 |
| `make runtime-check` | EXIT:0 |
| `make operational-persistence-check` | EXIT:0 |
| `make integration-replay-check` | EXIT:0 |
| `make historical-research-check` | EXIT:0 |
| `make seven-majors-check` | EXIT:0 — backend 38 tests, frontend 24 tests, Python 8 contract tests |
| `make operational-packaging-check` | EXIT:0 |
| `make private-beta-check` | EXIT:0 |
| `make dashboard-check` | EXIT:0 |
| `make security-check` | EXIT:0 |
| `make phase2-check` | EXIT:0 |
| `make handoff-check` | EXIT:0 |

Focused M47 timing evidence (host-specific, NTFS/fuseblk):

- `src/runtime/__tests__/sevenMajors.test.ts` — 11 tests in 57 ms (includes the one-fixture-week replay across all seven pairs).
- `src/app/api/dashboard/__tests__/route.test.ts` — 13 tests in 293 ms.
- `src/signals/__tests__/pipeline.test.ts` — 14 tests in 523 ms.

Non-fatal environment note: backend tests logged `[db] health check failed (ECONNREFUSED)` because the local PostgreSQL container was not running; all 676 backend tests passed.
