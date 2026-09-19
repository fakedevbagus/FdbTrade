# Completion Report: P15-04 — Implement broker health and drift checks

Prompt ID: P15-04
Phase: P15 Broker Read-only
Date/time UTC: 2026-09-12T12:15:00Z
Branch/commit: main

## What changed
- Created broker health and position drift detection subsystem in `contracts/src/broker/drift.ts`:
  - `BrokerDriftReport` and `BrokerDiscrepancy` schemas with typed discrepancy codes (`POSITION_QTY_MISMATCH`, `POSITION_SIDE_MISMATCH`, `PHANTOM_APP_POSITION`, `UNTRACKED_BROKER_POSITION`, `PRICE_DRIFT_EXCEEDED`, `EQUITY_DRIFT_EXCEEDED`, `STALE_BROKER_FEED`) and severities (`info`, `warning`, `critical`).
  - `BrokerDriftChecker`: performs pure read-only comparison between internal app positions/ledger and broker positions/account:
    - Identifies phantom app positions and untracked broker positions.
    - Compares position direction/side and quantity (with configurable tolerance).
    - Compares open price drift and account equity drift against relative threshold percentages.
    - Flags stale broker feed observations.
    - Content-addressed deterministic report IDs (`brkdrf_<hash16>`).
  - `BrokerHealthMonitor`: tracks heartbeat timestamps, ping latency, and consecutive failures to evaluate status (`healthy`, `degraded`, `unhealthy`).
  - HARD ACCEPTANCE GUARANTEE: `BrokerDriftChecker` and `BrokerHealthMonitor` are strictly read-only diagnostics; NO order submission, execution, or auto-heal trading logic exists.
- Exported drift module via `contracts/src/broker/index.ts`.
- Implemented comprehensive unit tests in `contracts/src/__tests__/broker-drift-health.test.ts` (12 tests).

## Files changed
- `contracts/src/broker/drift.ts` (new)
- `contracts/src/broker/index.ts` (exported drift module)
- `contracts/src/__tests__/broker-drift-health.test.ts` (new)
- `02_REPORTS/P15-04_COMPLETION_REPORT.md` (new)

## Tests executed
- `pnpm --filter @fdbtrade/contracts test -- src/__tests__/broker-drift-health.test.ts`: 12/12 passed.
- `pnpm --filter @fdbtrade/contracts test`: 33 files / 475 tests passed.
- `pnpm --filter @fdbtrade/contracts typecheck`: 0 errors.
- `pnpm --filter @fdbtrade/contracts lint`: 0 errors.
- `pnpm --filter @fdbtrade/backend test`: 68 files / 597 tests passed.
- `python3 -m unittest discover tests`: 476/476 passed.

## Acceptance criteria
- [x] Discrepancies never trigger automatic orders.
- [x] No auto-heal through trading.
- [x] Quantity, side, phantom, untracked, price, equity discrepancies correctly raised with appropriate codes and severities.
- [x] Broker health monitor evaluates latency and consecutive failure degradation.
- [x] All internal timestamps are UTC.
- [x] Deterministic behavior for deterministic inputs.
- [x] Relevant tests pass from a clean environment.
- [x] Lint/typecheck/build are clean for affected packages.
- [x] No unrelated files are modified without justification.
- [x] Completion report is written.

## Known limitations / blockers
- Real-time automated alerts on drift will integrate through the operational alerting center when execution is enabled.

## Follow-up required before next prompt
- Phase P15 is complete. Next prompt per `RUN_ORDER.md`: P16-01 (Demo Execution) — Open execution adapter only for demo.

## Risk notes
- Read-only diagnostics only. Zero broker execution authority. Strategy, feature, and UI layers remain decoupled from broker access.
