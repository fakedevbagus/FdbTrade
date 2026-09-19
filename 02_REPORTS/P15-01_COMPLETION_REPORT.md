# Completion Report: P15-01 — Finalize broker adapter contract

Prompt ID: P15-01
Phase: P15 Broker Read-only
Date/time UTC: 2026-09-12T11:55:00Z
Branch/commit: main

## What changed
- Created provider-neutral typed contract in `contracts/src/broker/contract.ts`:
  - Canonical entities with Zod schemas: `BrokerAccount`, `BrokerQuote`, `BrokerPosition`, `BrokerOrderRead`, `BrokerTrade`, `BrokerHealth`.
  - Typed interface `BrokerReadOnlyAdapter` strictly limited to read queries (`getAccount`, `getQuotes`, `getPositions`, `getOrders`, `getTrades`, `getHealth`).
  - Read-only service wrapper `BrokerReadOnlyService` that verifies absence of execution/write methods at construction, dynamically intercepts forbidden write operations (`createOrder`, `order_send`, `modifyOrder`, `cancelOrder`, etc.) throwing `BrokerReadOnlyViolationError`, and performs fail-closed schema validation on all adapter returns.
- Exported broker module via `contracts/src/broker/index.ts` and `contracts/src/index.ts`.
- Implemented comprehensive unit tests in `contracts/src/__tests__/broker-contract.test.ts` (20 tests).
- Documented durable decision in `docs/adr/ADR-0029-broker-read-only-adapter-contract.md`, indexed in `docs/adr/README.md`, and registered in `tests/test_ci_contracts.py`.

## Files changed
- `contracts/src/broker/contract.ts` (new)
- `contracts/src/broker/index.ts` (new)
- `contracts/src/index.ts` (barrel export)
- `contracts/src/__tests__/broker-contract.test.ts` (new)
- `docs/adr/ADR-0029-broker-read-only-adapter-contract.md` (new)
- `docs/adr/README.md` (ADR-0029 indexed)
- `tests/test_ci_contracts.py` (ADR-0029 registered)
- `02_REPORTS/P15-01_COMPLETION_REPORT.md` (new)

## Tests executed
- `pnpm --filter @fdbtrade/contracts test -- src/__tests__/broker-contract.test.ts`: 20/20 passed.
- `pnpm --filter @fdbtrade/contracts test`: 30 files / 446 tests passed.
- `pnpm --filter @fdbtrade/contracts typecheck`: 0 errors.
- `pnpm --filter @fdbtrade/contracts lint`: 0 errors.
- `python3 -m unittest tests.test_ci_contracts`: 18/18 passed.
- `python3 -m unittest discover tests`: 476/476 passed.

## Acceptance criteria
- [x] Adapters compile against the contract.
- [x] Write operations are physically unreachable from read-only service.
- [x] All internal timestamps are UTC.
- [x] Typed contracts and schema validation at boundaries.
- [x] Relevant tests pass from a clean environment.
- [x] Lint/typecheck/build are clean for affected packages.
- [x] No unrelated files are modified without justification.
- [x] Completion report is written.

## Known limitations / blockers
- Real MT5 connection depends on external terminal bridge; development Linux host uses fixture/mock adapter per constitution.

## Follow-up required before next prompt
- Proceed to P15-02: Implement MT5 read-only adapter.

## Risk notes
- No broker write operations exist in read-only adapter or service. Strategy, feature, and UI layers remain decoupled from broker access.
