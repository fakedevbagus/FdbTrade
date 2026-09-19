# ADR-0031: Live gate preflight, approval, pilot controls and circuit breakers

- Status: Accepted
- Date: 2026-09-12 (UTC)
- Deciders: FdbTrade owner (approved via P17 prompt pack)
- Supersedes: none
- Related: ADR-0003 (architecture boundaries), ADR-0004 (UTC time policy), ADR-0005 (live trading OFF by default), ADR-0020 (research lab validation gates), ADR-0022 (independent risk engine), ADR-0025 (append-only audit log), ADR-0028 (operational controls RBAC), ADR-0030 (demo execution and environment guards)

## Context

Phase P17 opens the live gate: the controlled, human-approved path from demo execution (P16) to a tiny live pilot. The frozen blueprint requires execution progression Alert -> Paper -> Demo -> Tiny live, live execution OFF by default, and manual approval before any live session. Live enablement must be machine-checkable, auditable, reversible, and fail closed.

## Decision

1. **Preflight checklist (P17-01)**: `runLivePreflight` evaluates eight frozen gates (strategy_champion, paper_period, demo_stability, risk_tests, reconciliation, outage_tests, operator_readiness, explicit_approval) over typed evidence bundles. `enabled: true` requires every gate to pass; one failed gate blocks live. Freshness thresholds (reconciliation age, outage-test age, operator-ack age) make stale evidence fail closed. Results are content-addressed (`lpf_` + FNV-1a64) and deterministic.
2. **Manual approval (P17-02)**: a live session requires an immutable, append-only approval record carrying authenticated actor, reason, UTC timestamp, expected limits and an expiry instant. Approvals never mutate; a new decision is a new record (superseding pointer only). Expired approvals authorize nothing.
3. **Pilot controls (P17-03)**: tiny-live pilot configuration must be strictly tighter than the demo configuration (minimum order size, symbol allowlist, session/time window, max orders, emergency stop). A pilot config that is not stricter fails closed.
4. **Circuit breakers (P17-04)**: risk, data, broker and performance thresholds disable NEW entries deterministically; the exit-management path stays available where safe. Breaker trips are append-only, auditable events with `stateDeleted: false` semantics (rollback flips flags, never deletes state).
5. **Post-live review (P17-05)**: every pilot session ends with a reproducible report (signals, fills, slippage, PnL, risk events, provider health, paper divergence) and an explicit go/no-go decision. No promotion without evidence.

All internal timestamps UTC; no broker calls from contract code; no secrets in schemas, fixtures or logs (secret-shaped keys rejected at the boundary).

## Consequences

- Live trading remains OFF by default; enabling requires preflight pass + human approval + pilot config, all verified in code.
- The `live_execution` feature-flag lock from ADR-0028 stays: the flag alone can never enable live; the P17 gate chain owns authority.
- Demo (P16) and live (P17) share the guard/monitor primitives but live adds the human-approval and pilot-tightness layers.

## Verification

- `pnpm --filter @fdbtrade/contracts test` covers preflight gates, approval immutability/expiry, pilot strictness, breaker determinism and review reproducibility (`live-*.test.ts`).
- CI contract suite `python3 -m unittest tests.test_ci_contracts` verifies ADR indexing.
