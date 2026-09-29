# ADR-0054: Projection-only paper and outcome workbench

- Status: Accepted
- Date: 2026-09-29
- Deciders: FdbTrade private operator
- Supersedes: no R0.9, R1.6, or R1.7 business logic; adds a read projection and private UI
- Related: ADR-0037, ADR-0040, ADR-0042, ADR-0047, ADR-0052, ADR-0053
- Work unit: R1.8

## Context

R1.7 exposes the strict operator-confirmed paper mutation and durable run reads,
but its run projection does not contain enough durable facts for an operator to
review the exact active candidate and verified R1.6 assumptions before acting,
or to inspect fills, position events and reconciliation after a run. Moving
those calculations into a browser would create a second authority and permit
refresh or client state to diverge from SQLite.

## Decision

1. `/paper/workbench` is private, dynamic and paper-only. Initial render,
   refresh and run reopening issue authenticated GETs and never submit work.
2. A read-only `DurablePaperWorkbenchProjection` joins existing immutable
   signal, R1.6 resolution, risk-state, run, fill, position-event,
   reconciliation and outcome records. It contains no risk, conversion, cost,
   fill, ledger, reconciliation or outcome calculation and performs no writes.
3. Every list/detail GET runs R1.6 recovery and R0.9 recovery/reconciliation
   before returning projections. Corrupt or unknown evidence fails closed.
4. The browser validates exact response shapes. Unknown lifecycle states and
   unsafe flags are unavailable/degraded, never success.
5. The confirmation control requires an explicit checkbox and submits exactly
   `inputResolutionId`, positive `requestedQuantityUnits`, and the literal
   `confirm-paper-run`. A synchronous client lock prevents double clicks while
   R1.7 idempotency remains the durable replay boundary.
6. The UI prominently distinguishes kill/red risk, pending, running,
   succeeded, blocked, rejected, failed, empty, unavailable and loading states.
   Registered baseline costs are explicitly labeled non-provider observations.
7. Results are never stored in browser persistence. Run detail is reopened by
   durable GET after navigation, refresh or restart.
8. No migration, scheduling, automatic submission, external transport,
   authority rule change, research promotion, legacy-backtest rewire or M48
   wiring is introduced.

## Consequences

- Operators can review the complete durable decision-to-outcome lineage without
  granting the browser authority.
- Existing R1.7 POST strictness and R0.9 persisted-risk ordering remain intact.
- Projection shape is intentionally strict; incompatible or malformed backend
  responses degrade visibly rather than being interpreted as successful.
- The migration count remains twelve.

## Verification

Focused frontend tests cover no-submit render/refresh, explicit confirmation,
exact payload, double-submit, private/unavailable and malformed responses.
Focused backend tests cover verified R1.6 assumptions, active candidate, risk
state, fills, position events, reconciliation, outcome, restart GET and
rejected/failed behavior. Python contracts lock source separation, wording,
route protection, M48 hashes, migration order and evidence progression. Final
acceptance is `make toolchain-gate` at 15/15 PASS with zero non-pass.
