# ADR-0053: Operator-confirmed paper API

- Status: Accepted
- Date: 2026-09-27
- Deciders: FdbTrade private operator
- Supersedes: no R0.9 business logic; adds an authenticated adapter over ADR-0042 and ADR-0052
- Related: ADR-0037, ADR-0039, ADR-0040, ADR-0042, ADR-0052
- Work unit: R1.7

## Context

R0.9 owns durable risk decisions, paper orders, fills, reconciliation and
paper-only outcomes. R1.6 removed caller authority over conversion and cost
inputs by requiring a verified resolution identity. No authenticated operator
boundary exposed that flow, so a future browser could not request a paper run
without either duplicating authority logic or widening the trusted request.

The API must remain an explicit single-user action. It must not schedule,
retry in the background, originate provider orders, or accept spread,
slippage, conversion provenance or market-data identities selected by a UI.

## Decision

1. Authenticated strict `POST /api/paper/runs` is the sole operator-confirmed
   mutation. It requires the literal `confirmation: "confirm-paper-run"`, one
   R1.6 `inputResolutionId`, and a positive requested quantity. Unknown fields
   and query parameters are rejected.
2. The route recovers and verifies the R1.6 input authority, reopens the
   resolution, registers the frozen R0.9 baseline from its authoritative
   checked time, then runs R0.9 recovery and reconciliation before invoking
   `RiskPaperAuthority.run`.
3. The route passes only `inputResolutionId` and quantity into R0.9. Caller
   cost, conversion, dataset, risk-decision and execution fields never cross
   that boundary.
4. `GET /api/paper/runs` and `GET /api/paper/runs/{id}` are authenticated
   durable projections. `RiskPaperAuthority` exposes read-only `listRuns` and
   `getRun` adapters; business rules remain in R0.9.
5. Responses preserve durable status and add `operatorState`. A risk-rejected
   durable `blocked` run is projected as `rejected`; `blocked`, `failed`,
   `pending`, `running` and `succeeded` remain distinct.
6. Identical POST replay returns the same run without duplicate decisions,
   orders or outcomes. Divergent replay and corrupt/tampered authority
   evidence return conflict responses and fail closed.
7. A persisted approved risk decision remains required by the SQLite ledger
   before paper submit, fill or outcome events. Kill decisions create no
   fills. Release remains an explicit separate risk-control action.
8. No migration, UI, scheduler, provider/network access, demo/live transport,
   R0.7 rule change, research promotion, legacy-backtest rewire or M48 wiring
   is introduced.

## Consequences

- One authenticated POST is auditable as the explicit operator action; no
  automatic paper execution path exists.
- Browser callers cannot manufacture conversion or cost authority.
- API consumers can distinguish rejected risk from other blocked or failed
  operational states without rewriting durable R0.9 status.
- Restart recovery and reconciliation happen before a new paper mutation.
- The migration ledger remains at twelve.

## Verification

File-backed route tests cover authentication, strict unknown-field rejection,
literal confirmation, approved execution, kill rejection without fills,
release behavior, idempotent replay, divergent replay rejection, restart
recovery, reconciliation, missing/tampered resolution blocking, truthful
failed-state projection, list/detail reads and method guards. R0.9 and R1.6
authority suites remain green. Final acceptance is `make toolchain-gate` with
15/15 PASS and zero non-pass.