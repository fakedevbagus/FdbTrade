# Completion Report

Prompt ID: P15_Broker_Read-only (P15-01 through P15-04 complete)
Phase: P15 Broker Read-only
Date/time UTC: 2026-09-12T12:20:00Z
Branch/commit: main

## What changed

Phase 15 Broker Read-only is complete:
- **P15-01 (Finalize broker adapter contract)**: Created provider-neutral typed contract (`contracts/src/broker/contract.ts`) with Zod schemas for `BrokerAccount`, `BrokerQuote`, `BrokerPosition`, `BrokerOrderRead`, `BrokerTrade`, and `BrokerHealth`. Implemented `BrokerReadOnlyAdapter` and `BrokerReadOnlyService` which physically omits and dynamically blocks write/execution methods (`createOrder`, `order_send`, `cancelOrder`, etc.). Adopted ADR-0029.
- **P15-02 (Implement MT5 read-only adapter)**: Created MT5 demo/wire fixture dataset (`contracts/src/broker/mt5Fixtures.ts`) and isolated MT5 read-only adapter (`contracts/src/broker/mt5Adapter.ts`) with pluggable `Mt5Transport`, in-memory `FixtureMt5Transport`, explicit typed errors (`Mt5ConnectionError`, `Mt5PayloadError`, `Mt5TimeoutError`), and UTC/units normalization. Write operations (`order_send`) are physically absent.
- **P15-03 (Implement quote/account sync)**: Created sync engine (`contracts/src/broker/sync.ts`) providing periodic sync from read-only adapters, freshness tracking with configurable max staleness thresholds, deduplication of historical trades, idempotent deterministic snapshot digests (`bsync_<hash16>`), and fail-safe degradation on network outage.
- **P15-04 (Implement broker health and drift checks)**: Created drift detection subsystem (`contracts/src/broker/drift.ts`) and health monitor (`BrokerHealthMonitor`). Compares internal application state against broker read-only state for quantity mismatch, side mismatch, phantom app positions, untracked broker positions, open price drift, and equity drift. STRICT GUARANTEE: Read-only observational diagnostics only; discrepancies never trigger automatic orders; no auto-heal through trading.

Phase gate "Broker read-only sync; NO order submission" is satisfied.

## Files changed

- `contracts/src/broker/contract.ts` (new)
- `contracts/src/broker/mt5Fixtures.ts` (new)
- `contracts/src/broker/mt5Adapter.ts` (new)
- `contracts/src/broker/sync.ts` (new)
- `contracts/src/broker/drift.ts` (new)
- `contracts/src/broker/index.ts` (new)
- `contracts/src/index.ts` (barrel export)
- `contracts/src/__tests__/broker-contract.test.ts` (new)
- `contracts/src/__tests__/broker-mt5-adapter.test.ts` (new)
- `contracts/src/__tests__/broker-sync.test.ts` (new)
- `contracts/src/__tests__/broker-drift-health.test.ts` (new)
- `docs/adr/ADR-0029-broker-read-only-adapter-contract.md` (new)
- `docs/adr/README.md` (ADR-0029 indexed)
- `tests/test_ci_contracts.py` (ADR-0029 registered)
- `02_REPORTS/P15-01_COMPLETION_REPORT.md` (new)
- `02_REPORTS/P15-02_COMPLETION_REPORT.md` (new)
- `02_REPORTS/P15-03_COMPLETION_REPORT.md` (new)
- `02_REPORTS/P15-04_COMPLETION_REPORT.md` (new)
- `02_REPORTS/P15_COMPLETION_REPORT.md` (new)

## Tests executed

- `pnpm --filter @fdbtrade/contracts test` (33 files / 475 tests green, 49 new broker tests).
- `pnpm --filter @fdbtrade/backend test` (68 files / 597 tests green).
- `python3 -m unittest tests.test_ci_contracts` (18/18 tests green).
- `python3 -m unittest discover tests` (476/476 tests green).
- `pnpm --filter @fdbtrade/contracts typecheck` (0 errors).
- `pnpm --filter @fdbtrade/contracts lint` (0 errors).

## Acceptance criteria

- [x] P15-01: Adapters compile against the contract; write operations are physically unreachable from read-only service.
- [x] P15-02: Demo/fixture account data can populate canonical read-only entities; errors are explicit.
- [x] P15-03: Repeated sync is idempotent and stale state is visible.
- [x] P15-04: Discrepancies never trigger automatic orders; no auto-heal through trading.
- [x] Relevant tests pass from a clean environment.
- [x] Lint/typecheck/build clean for affected packages.
- [x] No unrelated files modified without justification.
- [x] Completion reports written.

## Known limitations / blockers

- MT5 terminal absent on Linux development host; adapter tested against wire fixtures and mock transport per constitution.
- Real demo order submission is deferred to P16.

## Follow-up required before next prompt

- Next prompt per `00_CONTROL/RUN_ORDER.md`: P16 (Demo Execution) — P16-01: Open execution adapter only for demo.

## Risk notes

- Trading safety: Live execution remains OFF by default. Order execution is physically absent in P15 read-only contracts and adapters. Discrepancies generate reports only and never trigger orders.
- Quant integrity: All internal timestamps are normalized to ISO 8601 UTC. Quant/strategy code does not touch broker interfaces directly.
- Security: No external credentials or endpoints committed; secret-like keys validated and excluded.
