# ADR-0040: Signal intelligence authority

- Status: Accepted
- Date: 2026-09-22
- Deciders: FdbTrade private-beta owner
- Supersedes: In-process-only signal evidence and registry authority assumptions in ADR-0015, ADR-0018 and ADR-0026
- Related: ADR-0005, ADR-0016, ADR-0017, ADR-0037, ADR-0038, ADR-0039
- Work unit: R0.7

## Context

The preserved rule, regime and signal components were deterministic in
isolation, but the local application had no durable authority for a rule
version, evaluation attempt, no-signal/blocked outcome, candidate provenance or
signal lifecycle. The dashboard pipeline still read fixture data directly and
could not prove that displayed intelligence came from an immutable R0.6
dataset. R0.7 must establish that authority without adding research,
backtesting, risk, paper brokerage, UI changes or any order transport.

## Decision

1. Migration `0006_signal_intelligence` makes SQLite authoritative for the
   versioned baseline rule, evaluation runs, evidence, canonical candidates
   and append-only lifecycle events. Registry, evidence, candidates and events
   are immutable; terminal runs cannot be rewritten or deleted.
2. The first authoritative rule is
   `authoritative-momentum-baseline` logic/config `1.0.0`. Its frozen config
   combines the existing deterministic ATR and rule-based regime primitives
   with aligned 5/20-bar momentum, closing confirmation, an ATR invalidation
   level and a 2R target. It uses no wall clock, randomness, fitted model or
   empirical outcome claim.
3. Every evaluation starts from a registered R0.6 dataset. Loading re-hashes
   the immutable artifact and checks record count. Any non-accepted quality
   state, quarantined/duplicate/gap count, stored stale state or effective
   staleness at the caller-supplied UTC assessment instant produces durable
   `blocked` evidence and no candidate. There is no fixture, empty-data or
   best-effort fallback.
4. A directional result is constructed through the canonical ADR-0017 signal
   builder. The signal retains rule and config versions, exact input metrics,
   regime evidence, dataset id and artifact digest provenance. `wait` is a
   successful explained evaluation, while `blocked` remains distinct from
   both `wait` and operational failure.
5. Evaluation identity is deterministic over dataset, rule versions and
   assessment instant. Runs progress `pending -> running -> succeeded|blocked|
   failed`; evidence and terminal state commit in one immediate transaction.
   Repeating the same request returns the original evidence. Repeating a
   compatible later assessment may reuse an identical canonical candidate but
   records separate assessment evidence.
6. Recovery moves interrupted `running` evaluations back to `pending`, verifies
   every evidence digest, reopens and re-hashes its source dataset, and checks
   candidate/evidence identity. A crash before the terminal transaction is
   replayable; loss of the response after commit cannot create a second
   candidate.
7. Candidate lifecycle is append-only. Creation records `identified`; an
   explicit UTC assessment appends `expired` exactly once when canonical signal
   expiry is reached. No background clock silently rewrites candidate state.
8. This authority is read-only decision support. It creates no order intent,
   risk decision, paper position, outcome, promotion or provider call. The
   existing fixture-backed dashboard pipeline is not promoted to authority and
   is not rewired in R0.7.

## Consequences

- A local restart preserves which rule version evaluated which verified data,
  including explained no-signal and fail-closed outcomes.
- SQLite remains the only durable metadata authority; candle bytes remain in
  R0.6 content-addressed artifacts.
- The baseline is deliberately a fixed rule, not a tuned claim of edge. Model
  training, backtest validation, promotion and outcome calibration require a
  later explicitly authorized work unit.
- No API or UI migration is implied. Existing display routes remain legacy
  read models until a later unit explicitly selects their authority.

## Verification

- Vitest publishes real immutable R0.6 datasets, evaluates the registered rule,
  reopens SQLite, checks dataset/artifact provenance, advances expiry and
  rejects mutation.
- Negative behaviors persist `blocked` evidence for gapped and stale datasets.
- Fault-injection tests prove pre-commit recovery and post-commit replay without
  duplicate candidates.
- Python contracts pin migration ownership, fail-closed markers and the absence
  of live/provider-order/M48 wiring.
- `make toolchain-gate` is the final bounded acceptance authority.
