# Completion Report

Prompt ID: P17_Live_Gate (P17-01 through P17-05 complete)
Phase: P17 Live Gate
Date/time UTC: 2026-09-12T16:45:00Z
Branch/commit: main (uncommitted working tree; commit deferred to owner)

## What changed

Phase 17 Live Gate is complete. Live trading remains OFF by default; the phase builds the authority CHAIN that alone can enable a tiny live pilot:

- **P17-01 (Live preflight checklist)**: `runLivePreflight` (`contracts/src/live/preflight.ts`) — 8 frozen gates (strategy_champion, paper_period, demo_stability, risk_tests, reconciliation, outage_tests, operator_readiness, explicit_approval), typed evidence schemas, stale-evidence fail-closed thresholds, deterministic content-addressed results (`lpf_`), schema-refined `enabled` (cannot disagree with outcomes).
- **P17-02 (Manual approval workflow)**: `contracts/src/live/approval.ts` — human-only actor policy (AI/LLM identities rejected at the schema), immutable append-only records (`lapp_`), mandatory reason + expected limits + expiry, strict expiry boundary, 24h duration ceiling, idempotent revocation with supersede pointers (history never rewritten).
- **P17-03 (Tiny-live pilot controls)**: `contracts/src/live/pilot.ts` — smallest permitted size (dust floor) + ceiling, symbol allowlist, trading days + UTC session window (overnight wrap), max orders/session, max concurrent positions, mandatory armed emergency stop (idempotent, `exitManagementPreserved: true`, `stateDeleted: false`); `assertPilotStricter` fails closed unless the pilot config is stricter than the demo config on every dimension.
- **P17-04 (Live rollback and circuit breakers)**: `contracts/src/live/breakers.ts` — 4 kinds (risk/data/broker/performance), 11 frozen metrics, deterministic first-breach order, stricter-than-demo defaults, idempotent trips, entries disabled while exits stay available, append-only audit history, explicit actor-attributed re-arm (never automatic), no forced liquidation.
- **P17-05 (Post-live review)**: `contracts/src/live/review.ts` — reproducible content-addressed session reports (`lrev_`) over signals, fills, slippage, PnL, risk events, provider health and paper divergence; evidence-gated go/no-go (forged `go` refused at the schema boundary).

ADR-0031 documents the phase architecture; ADR index and CI ADR registry updated.

Phase gate "Manual approval + tiny pilot + rollback" is satisfied: approval is immutable/audited/expiring, pilot is machine-checked stricter than demo, and breakers + emergency stop provide deterministic rollback with preserved exit path.

## Files changed

- `contracts/src/live/preflight.ts` (new)
- `contracts/src/live/approval.ts` (new)
- `contracts/src/live/pilot.ts` (new)
- `contracts/src/live/breakers.ts` (new)
- `contracts/src/live/review.ts` (new)
- `contracts/src/live/index.ts` (new barrel)
- `contracts/src/index.ts` (barrel export)
- `contracts/src/__tests__/live-preflight.test.ts` (new, 18 tests)
- `contracts/src/__tests__/live-approval.test.ts` (new, 13 tests)
- `contracts/src/__tests__/live-pilot.test.ts` (new, 22 tests)
- `contracts/src/__tests__/live-breakers.test.ts` (new, 16 tests)
- `contracts/src/__tests__/live-review.test.ts` (new, 13 tests)
- `docs/adr/ADR-0031-live-gate-preflight-approval-pilot-controls.md` (new)
- `docs/adr/README.md` (ADR-0031 indexed)
- `tests/test_ci_contracts.py` (ADR-0031 registered)
- `02_REPORTS/P17-01_COMPLETION_REPORT.md` .. `P17-05_COMPLETION_REPORT.md` (new)
- `02_REPORTS/P17_COMPLETION_REPORT.md` (new, phase gate)

## Tests executed

- `pnpm --filter @fdbtrade/contracts test` — 42 files / 611 tests green (82 new live-gate tests).
- `pnpm --filter @fdbtrade/contracts typecheck` — 0 errors.
- `pnpm --filter @fdbtrade/contracts lint` — exit 0 (pre-existing repo warnings only).
- `backend` typecheck — 0 errors (barrel export verified harmless downstream).
- `python3 -m unittest tests.test_ci_contracts` — 18/18 green (ADR-0031 registered, contiguous numbering verified).

## Acceptance criteria

- [x] P17-01: Live cannot be enabled when any gate is false.
- [x] P17-02: Approval is immutable/audited and expires safely; AI can never approve.
- [x] P17-03: Pilot configuration is stricter than normal demo configuration (machine-checked).
- [x] P17-04: Circuit breakers are deterministic, tested and auditable; exits preserved.
- [x] P17-05: Every live pilot ends with a reproducible report and evidence-gated go/no-go.
- [x] Relevant tests pass from a clean environment.
- [x] Lint/typecheck/build clean for affected packages.
- [x] No unrelated files modified without justification.
- [x] Completion reports written (P17-01..P17-05 + phase).

## Known limitations / blockers

- MT5 terminal absent on the Linux dev host; no live wire transport exists. All live-gate logic is contract-layer with deterministic fixtures/mocks per constitution; the P16 `liveExecutionEnabled=true` prohibition and the P13-05 `live_execution` flag lock REMAIN in force — enabling live also needs backend wiring that no prompt in this phase requested.
- Evidence bundles (champion, paper/demo periods, risk reports, reconciliations) are caller-supplied at the contract boundary; the checklist validates shape/thresholds/freshness, not upstream ledger truth.
- Approval log, breaker panel, pilot sessions and review reports are in-memory per process; persistence deferred to a later DB-integration prompt.

## Follow-up required before next prompt

- Next prompt per `00_CONTROL/RUN_ORDER.md`: P18 (Advanced Alpha) — only after the owner accepts this phase gate report.

## Risk notes

- Trading safety: live remains OFF by default and requires the full chain preflight -> human approval -> pilot config -> breaker panel; every step fails closed; exit-management path never removed; rollback never deletes state; re-arm requires a human actor with a reason.
- Quant integrity: deterministic evaluation everywhere (frozen orderings, strict thresholds, content-addressed ids); UTC-only timestamps; stale evidence fails closed; go/no-go measured against paper divergence, not narrative.
- Security: no secrets in any schema, fixture or log; secret-shaped keys rejected at boundaries; human-only approvals enforced by pattern.

