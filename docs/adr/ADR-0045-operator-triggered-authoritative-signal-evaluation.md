# ADR-0045: Operator-triggered authoritative signal evaluation

- Status: Accepted
- Date: 2026-09-24
- Deciders: FdbTrade private-beta owner
- Supersedes: Production-access assumptions for the legacy signal scanner; it does not supersede its historical behavior
- Related: ADR-0005, ADR-0037, ADR-0039, ADR-0040, ADR-0041, ADR-0042, ADR-0043, ADR-0044
- Work unit: R0.12

## Context

R0.7 established deterministic SQLite authority for signal rules, evaluation
runs, evidence, candidates and lifecycle events over verified R0.6 datasets.
Its behavior was exercised directly in authority tests, but no production API
instantiated `SignalIntelligenceAuthority`. The visible scanner continued to
use the earlier fixture-oriented read pipeline, while the optional runtime
scheduler remained intentionally observation-only.

R0.12 must expose one narrow operator-triggered path into the existing R0.7
authority. It must not widen the data scope, schedule automatic work, invoke
research or risk/paper authorities, or make the UI authoritative.

## Decision

1. `POST /api/signals/evaluations` is the only new production entry point. It
   requires the private authenticated session and accepts exactly a registered
   R0.6 `datasetId` and a canonical millisecond-precision UTC
   `assessedAtUtc`. Unknown fields and unsupported HTTP methods fail closed.
2. The route obtains the canonical application SQLite connection and R0.6
   artifact root, then constructs `SignalIntelligenceAuthority`. It does not
   copy rule logic, read fixture-provider candles or call the legacy scanner.
3. The frozen `authoritative-momentum-baseline` rule at logic/config version
   `1.0.0` is registered idempotently. A mismatched registered digest remains
   an internal fail-closed error.
4. Before evaluation, the R0.7 recovery operation resets interrupted running
   work and verifies existing evidence and dataset provenance. Any corrupt
   evidence blocks the request; it is never ignored or replaced.
5. Evaluation remains identified by the R0.7 dataset/rule/assessment key.
   Repeating the same request returns the existing durable result with
   `executed=false` and cannot duplicate evidence or a candidate.
6. `candidate`, `wait`, `blocked` and `failed` retain their R0.7 meanings.
   The response reports SQLite authority, frozen rule identity, recovery
   evidence and literal safety exclusions. It creates no research run, risk
   decision, paper order, fill, outcome or operational event.
7. No migration is added. SQLite remains the only mutable durable metadata
   authority and the active migration ledger remains nine migrations through
   `0009_operational_hardening`.
8. The scheduler stays off by default and observation-only when enabled. The
   frontend remains a projection and receives no new mutation surface. Live
   execution, provider-order transport, credentialed/network providers, model
   promotion and M48 remain disconnected.

## Consequences

- An authenticated local operator can now create or replay authoritative R0.7
  signal evidence from a previously published, integrity-checked R0.6 dataset.
- Restart and interrupted-work recovery are observable at the production route
  boundary without creating a second workflow or state authority.
- The legacy scanner and dashboard remain non-authoritative historical read
  paths. R0.12 does not silently relabel their output as R0.7 evidence.
- Research, risk and paper execution still require separately bounded operator
  actions or future authority. A signal candidate alone cannot create an order.
- The route is decision support only. Its output is not calibrated confidence,
  live evidence, profitability evidence or model-promotion approval.

## Verification

- File-backed route tests publish real R0.6 artifacts and prove candidate,
  explained wait, quality-blocked evidence, close/reopen replay and interrupted
  run recovery through the actual route handler.
- Negative tests cover authentication, strict request shape, malformed UTC,
  unknown datasets and unsupported methods without creating a signal run.
- Cross-authority assertions prove that research, risk-paper, paper-order,
  outcome and operational-event tables remain untouched.
- Python contracts pin production wiring, safety exclusions, nine migrations
  and all ten quarantined M48 hashes.
- `make toolchain-gate` is the final bounded acceptance authority.
