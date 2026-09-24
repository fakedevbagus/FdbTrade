# ADR-0051: Robustness and selection-bias evidence

- Status: Accepted
- Date: 2026-09-24
- Deciders: FdbTrade private operator
- Supersedes: no authority; adds bounded robustness evidence beside ADR-0050
- Related: ADR-0019, ADR-0020, ADR-0041, ADR-0048, ADR-0049, ADR-0050
- Work unit: R1.5

## Context

R1.4 made chronological and rolling out-of-sample evidence durable, but one
frozen cost assumption cannot establish robustness. Re-running only favorable
stress cases would create selection bias, while silently weakening minimum
samples would turn sparse evidence into false certainty.

R1.5 must expose cost sensitivity, sample limitations and regime/timeframe
coverage without tuning the R0.7 rule, treating research as confidence, or
creating a promotion path. The experiment plan therefore has to exist before
results and remain complete after restart or replay.

## Decision

1. Migration `0011_robustness_selection_bias_authority` adds separate immutable
   configuration, experiment-run, trial-ledger, artifact and result tables.
   SQLite remains mutable metadata authority; newline-terminated SHA-256-
   addressed JSON remains immutable evidence below the R1.5 artifact root.
2. Configuration `frozen-baseline-robustness-selection-bias@1.0.0` accepts only
   a successful, intact R1.4 temporal run. It retains the same frozen R0.7 rule,
   R0.8 execution assumptions and R1.4 temporal plan.
3. One baseline plus five bounded stress trials are fixed in code before any
   result is evaluated: spread 0.6/1.2/2.4 pips and slippage 0.1/0.3/0.6 pips,
   with mid, adverse and combined-adverse cases. Commission, latency, exit
   priority, quantity, warmup and signal logic are not searched or tuned.
4. Queueing atomically writes the parent experiment and every ordered trial
   declaration. Trial identities, ordinals, declaration digests and the whole
   plan digest are immutable. A conclusion cannot commit unless every declared
   trial completed and appears in exactly that order with matching result bytes.
5. Every trial reruns the chronological test section and every rolling
   walk-forward test fold from R1.4. Results record all frozen metrics; no
   favorable trial is selected as a replacement baseline.
6. Minimum evidence is predeclared as 120 dataset bars, three walk-forward
   folds, three baseline closed trades and one closed trade assigned to a
   known regime. Failure to meet a minimum produces `insufficient-evidence`,
   not a weakened threshold.
7. A sufficiently sampled result is `rejected` when baseline or stressed OOS
   return is non-positive, adverse-cost return retention is below 50%, cost
   sensitivity is unstable, or worst drawdown exceeds 25%. It is `pass` only
   when every predeclared condition passes. Every conclusion carries explicit
   limitations.
8. The evidence reports the dataset timeframe and deterministic regime buckets
   for baseline chronological-test closed trades. A single-dataset,
   single-timeframe result remains an explicit limitation rather than an
   implicit cross-market claim.
9. Recovery resets only interrupted parent runs. Completed trial rows remain
   immutable and must reproduce byte-for-byte; terminal replay verifies R1.4
   input bytes, R0.6 dataset bytes, all trial rows, the decision and the R1.5
   artifact before returning evidence.
10. All results remain historical-only, uncalibrated, non-promotional and not
    operational outcome authority. R0.7 rules, legacy backtests, risk/paper,
    providers, scheduling, ML, execution transports and M48 remain disconnected.

## Consequences

- Cost and slippage sensitivity can no longer be reported from a silent subset
  of trials.
- Sparse, unstable or adverse evidence becomes an explicit terminal conclusion
  with limitations rather than a favorable headline metric.
- This unit does not authorize parameter optimization, confidence calibration
  or promotion. A `pass` means only that this bounded historical experiment met
  its predeclared checks.
- The active ledger contains eleven ordered reversible migrations.

## Verification

File-backed tests cover full trial predeclaration, duplicate identity, all three
conclusions, sparse samples, unstable results, adverse costs/drawdown, restart
after completed trials, R1.4/R1.5 artifact tamper rejection and immutable
terminal evidence. Migration tests execute zero-to-eleven apply, rollback of
`0011`, and reapply. Python contracts pin source wiring, hashes, safety
exclusions, predecessor preservation, M48 hashes, documentation and the R1.6
stop boundary. Final acceptance is `make toolchain-gate` with 15/15 PASS and
zero non-pass.
