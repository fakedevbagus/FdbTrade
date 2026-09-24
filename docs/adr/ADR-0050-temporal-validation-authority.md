# ADR-0050: Temporal validation authority

- Status: Accepted
- Date: 2026-09-24
- Deciders: FdbTrade private operator
- Supersedes: no authority; adds bounded temporal evidence beside ADR-0041
- Related: ADR-0019, ADR-0020, ADR-0039, ADR-0040, ADR-0041, ADR-0048, ADR-0049
- Work unit: R1.4

## Context

R0.8 made a full-dataset deterministic baseline run authoritative, and R1.2/R1.3
made that evidence available through an authenticated operator workflow. It did
not establish chronological train/validation/test or rolling out-of-sample
evidence. The earlier research-lab split and walk-forward helpers were pure
calculations without durable SQLite ownership, immutable result publication,
recovery, or input/output integrity verification.

Temporal evidence must not become parameter search, confidence calibration, a
promotion decision, or a second signal authority. It must exercise the frozen
R0.8 baseline with its existing costs and deterministic rule, while making
future leakage, split overlap, dataset drift, and artifact corruption explicit
failures.

## Decision

1. Migration `0010_temporal_validation_authority` adds separate immutable
   configuration, run, artifact, and result tables. SQLite is the mutable
   metadata authority; newline-terminated, SHA-256-addressed JSON below the
   R1.4 artifact root is the immutable evidence authority.
2. Configuration `frozen-baseline-temporal-validation@1.0.0` is fixed to the
   registered `baseline-historical-evaluation@1.0.0` and the unchanged
   `authoritative-momentum-baseline@1.0.0` rule/config. Registration verifies
   both predecessor digests before accepting R1.4 metadata.
3. The chronological plan uses a 50/25/25 train/validation/test allocation,
   two-bar gaps, at least ten bars per section, and seed
   `r1.4-frozen-temporal-baseline`. Sections are half-open, ordered, disjoint,
   and carry index plus UTC boundaries. The gaps after train and validation are
   recorded as explicit embargo boundaries.
4. Rolling walk-forward uses 40 train bars, a two-bar pre-test gap, 12 test
   bars, a 14-bar step, a two-bar post-test embargo, and at least three folds.
   Because step equals test plus embargo, out-of-sample test windows never
   overlap and each next test starts only after the prior embargo. A later
   train window may contain observations that were historical by that later
   fold; it can never contain its own or a future fold's test bars.
5. Train, validation, test, and every walk-forward test fold run the frozen
   deterministic subject with the R0.8 initial equity, quantity, warmup,
   realistic spread/slippage/latency/commission/exit policy, and a deterministic
   section/fold seed. There is no fitting or selection because the baseline has
   no trainable parameter in this unit.
6. The R0.6 source dataset identity and full artifact digest are pinned once.
   Each engine result additionally pins the digest of the exact candle slice it
   consumed. Split, walk-forward, costs, configuration, signal rule, seed,
   result, manifest, metric, and summary digests remain linked in SQLite and the
   immutable artifact.
7. Dataset quality failures and insufficient history create durable `blocked`
   evidence. Overlap, reverse chronology, wrong gaps, future leakage, or test
   embargo overlap are rejected. Corrupt configuration or input evidence fails
   the run closed.
8. Recovery resets only interrupted `running` rows, then verifies registered
   configuration, input dataset bytes, output artifact bytes, summaries,
   canonical plans, engine results, manifests, metrics, costs, and seeds.
   Terminal replay performs the same verification before returning evidence.
9. All evidence is historical-only, uncalibrated, non-promotional, and not
   operational-outcome authority. R0.7 signals, legacy backtest routes, risk,
   paper, providers, scheduling, ML, and M48 remain disconnected.

## Consequences

- The frozen baseline now has durable chronological and rolling out-of-sample
  evidence with explicit leakage boundaries and reproducible lineage.
- A dataset with fewer than 82 bars is insufficient for the frozen minimum of
  three walk-forward folds and is recorded as blocked rather than weakened.
- The configuration deliberately exposes no search space. Robustness,
  sensitivity, sample sufficiency, and selection-bias conclusions remain R1.5.
- The active ledger contains ten ordered reversible migrations.

## Verification

File-backed behavior tests cover successful execution and restart, exact
dataset/slice/config/cost/seed lineage, overlap and future-leakage rejection,
embargo violations, quality and sample blocking, interrupted recovery,
idempotent replay, immutable tables, and input/output tamper rejection.
Migration tests execute zero-to-ten apply, rollback of `0010`, and reapply.
Python contracts pin source wiring, safety exclusions, R0.7/R0.8/legacy
preservation, ten M48 hashes, authority documentation, and the R1.5 stop
boundary. `make toolchain-gate` remains the final acceptance authority.
