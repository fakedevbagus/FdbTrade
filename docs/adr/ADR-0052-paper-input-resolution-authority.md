# ADR-0052: Paper input resolution authority

- Status: Accepted
- Date: 2026-09-24
- Deciders: FdbTrade private operator
- Supersedes: caller-supplied paper cost and conversion inputs in ADR-0042
- Related: ADR-0005, ADR-0036, ADR-0039, ADR-0040, ADR-0042, ADR-0046
- Work unit: R1.6

## Context

R0.9 correctly requires a durable approved risk decision before paper events,
but its internal request accepted spread, slippage and quote-to-account
conversion values from its caller. A future UI or API must not be able to make
those values authoritative. No provider authority is selected yet, so the
offline paper path needs deterministic, registered assumptions and verified
market-data lineage without inventing provider observations.

The approved universe is exactly EURUSD, GBPUSD, USDJPY, USDCHF, AUDUSD,
USDCAD and NZDUSD with a USD paper account. Four pairs therefore have identity
quote-to-USD conversion; three require inversion of the event-time USD-base
bar. No third-currency cross is needed or permitted in this universe.

## Decision

1. Migration `0012_paper_input_resolution` adds immutable config, lifecycle and
   resolution tables. SQLite remains the sole mutable durable metadata
   authority.
2. Configuration `registered-baseline-paper-inputs@1.0.0` registers 0.6 pip
   spread and 0.1 pip estimated slippage for every approved pair. These are
   explicitly baseline assumptions with `providerObservation=false`, not
   claimed market observations, and remain in force only until separately
   authorized provider authority exists.
3. Each resolution binds the R0.7 signal, its verified R0.6 source dataset, the
   verified execution dataset, exact signal event time, assessment time and
   config digest. Both datasets must be accepted, scope-compatible and contain
   exactly one bar at the event time.
4. EURUSD, GBPUSD, AUDUSD and NZDUSD resolve quote USD to account USD by
   identity. USDJPY, USDCHF and USDCAD resolve quote currency to USD by
   inverting the exact execution-dataset event-bar close. The bar and artifact
   digests remain in conversion lineage; third-currency crosses are empty.
5. Inputs older than two bars, inactive signals, missing evidence, ambiguous
   event bars, rejected quality, scope mismatch, config drift and corrupt
   artifacts produce an explicit durable `blocked` result. No fallback,
   interpolation, nearest-bar selection or caller override is allowed.
6. Resolution identity and content are deterministic. Duplicate requests
   reopen the same terminal record. Interrupted work is reset to pending;
   restart/recovery and every R0.9 consumption replay the config, candidate,
   dataset artifacts, event bar and resolution digest.
7. `RiskPaperAuthority.run` accepts only a verified `inputResolutionId` and
   requested quantity. It no longer accepts
   caller-supplied conversion, observed spread or estimated slippage. Its
   mandatory persisted approved-risk boundary and paper ledger semantics are
   unchanged.
8. This authority adds no route, UI, provider or network call, scheduling,
   automatic paper execution, demo/live/provider-order transport, signal-rule
   change, research promotion, legacy-backtest rewire or M48 wiring.

## Consequences

- A later operator-confirmed API can request or consume a resolution without
  trusting browser cost or conversion values.
- Baseline costs are transparent limitations, not provider observations.
- Every approved pair has one unambiguous quote-to-USD method under the current
  seven-major universe; extending the universe requires a new conversion
  policy and separate authorization.
- The active ledger contains twelve ordered reversible migrations.

## Verification

File-backed tests cover all seven pair orientations, identity/inverse rates,
empty cross lineage, exact event-time binding, duplicate replay, stale,
missing, ambiguous, mismatched and tampered inputs, config drift, interruption,
SQLite reopen, immutable records and R0.9 integration. Migration tests execute
zero-to-twelve apply, rollback of `0012`, and reapply. Python contracts pin the
authority wiring, source hashes, safety exclusions, predecessor preservation,
M48 hashes and R1.7 stop boundary. Final acceptance is `make toolchain-gate`
with 15/15 PASS and zero non-pass.
