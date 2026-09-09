# ADR-0018: Ensemble decision contract and auditable evidence preservation

- Status: Accepted
- Date: 2026-09-09 (UTC)
- Deciders: FdbTrade owner (blueprint v2 approval), Cline agent
- Supersedes: none
- Related: ADR-0003 (architecture boundaries), ADR-0004 (UTC policy), ADR-0005 (live trading OFF), ADR-0016 (regime engine), ADR-0017 (strategy interface and signal contract)

## Context

Phase P6 combines the P5 baseline strategies into one ensemble decision per
(instrument, timeframe, closed bar) and gates it by cost-aware edge. Before
any engine is coded, the frozen ensemble contract must exist: the blueprint
requires that the ensemble never hides individual strategy evidence, that
every decision carries full component-version lineage, and that model
confidence is always distinguishable from empirical performance (never a win
probability, never a profit guarantee).

## Decision

1. The ensemble contract lives in `contracts/src/ensemble/contract.ts`
   (Python mirror `quant/ensemblecore/contract.py`): decision classes
   `enter_long` / `enter_short` / `wait` (`wait` is a first-class explained
   outcome, never an error), vote stances `long`/`short`/`abstain`, a frozen
   9-code ensemble reason enum and a frozen 5-flag uncertainty enum.
2. A vote carries full lineage (strategy id + logic semver + config semver)
   plus the verbatim canonical Signal (with its own snapshotHash) when
   directional; a directional vote without a signal is invalid. Votes are
   sorted ascending by strategyId (deterministic wire form).
3. Evidence preservation is enforced by the schema: a decision carries ALL
   input votes verbatim, and the per-strategy contributions must mirror the
   votes (same strategies, stances, confidences) — the ensemble can never
   drop or rewrite strategy evidence.
4. Fixed per-regime weights are a versioned weight table
   (`ensembleWeightTableSchema`): every regime state must declare a record
   (empty allowed = no strategy eligible — fail-closed lookup, never a
   missing-key improvisation); any weight change bumps the table semver and
   is recorded on each decision via `weightsVersion`.
5. Correlation between strategies is an explicit, auditable penalty input
   (`pairCorrelations` keyed `a|b` ascending, correlations in [-1,1], plus a
   `penaltyFactor` in [0,1] and a provenance `source`) — penalizing
   strategies that are effectively the same bet.
6. Confidence is DECOMPOSED (`voteAgreement`, `weightedAgreement`,
   `regimeAlignment`, `correlationPenalty`, `calibration`) so every decision
   is explainable without re-running it. The calibration view keeps the
   EMPIRICAL hit-rate and its sample size strictly separate from model
   confidence; a null hit-rate requires sampleSize 0. Neither is ever a win
   probability or guarantee.
7. `decisionId` is deterministic
   (`ens_{instrument}_{timeframe}_{eventTimeUtc}`); `decisionHash` is sha256
   of `serializeEnsembleDecisionCanonical` (byte-identical TS/Python form;
   JS number formatting per P02-05). Idempotent evaluation of the same input
   yields the same id and hash.
8. `componentVersions` records the version of every component involved
   (ensemble engine, weight table, regime classifier, ...) — decisions are
   fully auditable.
9. The backend builder (`backend/src/ensemble/builder.ts`) is the single
   construction path (derives id, hashes, validates — fail closed),
   mirroring the P05-01 signal builder. TS/Python parity is pinned by the
   committed fixture `tests/fixtures/ensemble_parity.json`.

## Consequences

- P06-02..P06-05 (weighting engine, cost gate, calibration layer, ranking)
  implement only this contract; risk and later execution layers consume
  ensemble decisions only through it.
- Changing field set, enums, id form or serialization is a breaking change:
  bump `ensembleContractVersion` and supersede this ADR.
- The ensemble sits between strategy signals and risk — it never calls a
  broker, clock or random source (ADR-0003/0005 hard boundary).

## Verification

- `contracts` vitest: decision schema valid/malformed/boundary, vote
  lineage, weight-table regime completeness, correlation-pair ordering,
  calibration separation, serialization stability (17 cases).
- `backend` vitest: builder happy path, idempotency, fail-closed drafts,
  parity fixture writer (5 cases).
- Python stdlib: parse mirrors + fail-closed guards + committed fixture
  parity (28 cases).
- `make check` green.
