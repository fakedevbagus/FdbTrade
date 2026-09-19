# ADR-0030: Demo execution adapter and environment guards

- Status: Accepted
- Date: 2026-09-12 (UTC)
- Deciders: FdbTrade owner (approved via P16 prompt pack)
- Supersedes: none
- Related: ADR-0003 (architecture boundaries), ADR-0004 (UTC time policy), ADR-0005 (live trading OFF by default), ADR-0021 (paper broker and reconciliation), ADR-0029 (broker read-only adapter contract)

## Context

Phase P16 opens order execution capability, but strictly for demo/practice environments. Live broker order authority remains prohibited before the live gate (P17). A robust, fail-closed guard mechanism is required to guarantee that production/live credentials, endpoints, or broker accounts can never be accepted by the demo execution adapter, and that misconfiguration fails closed at startup.

## Decision

1. **Feature flag activation**: Demo order submission requires explicit feature flag activation (`demoExecutionEnabled: true`). By default, demo execution is OFF (`demoExecutionEnabled: false`).
2. **Live execution prohibition**: `liveExecutionEnabled` MUST be `false`. If `liveExecutionEnabled` is true in any demo context, startup halts fail-closed with `DemoMisconfigurationError`.
3. **Demo account verification**: Every broker account interacting with the demo execution adapter must have `isDemo === true`. Any account with `isDemo === false` is rejected with `LiveCredentialsRejectedError`.
4. **Endpoint & server filtering**: Broker server names and endpoint URIs are checked against approved demo server whitelists and anti-patterns. Any server or endpoint matching live keywords (`live`, `real`, `prod`, `production`, `mainnet`) is blocked with `LiveCredentialsRejectedError`.
5. **Typed contracts**: Orders submitted to the demo adapter require typed schemas (`DemoOrderIntent`, `DemoOrderExecutionResult`) with full lineage (`signalId`, `accountId`, `version`, UTC timestamps).

## Consequences

- Demo execution cannot accidentally route orders to real money accounts.
- Misconfiguration prevents application startup before any network connection or broker interaction occurs.
- Later prompts in Phase 16 build idempotent order submission, partial fill simulation, and automated rollback upon this foundation.

## Verification

- `pnpm --filter @fdbtrade/contracts test -- src/__tests__/demo-execution-guard.test.ts` verifies valid demo execution, live credential rejection, endpoint whitelisting, and startup failure paths.
- CI contract suite `python3 -m unittest tests.test_ci_contracts` verifies ADR index and format.
