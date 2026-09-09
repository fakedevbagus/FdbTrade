# Completion Report

Prompt ID: P06_Alpha_Ensemble (P06-01 through P06-05, executed in required order)
Phase: P6 Alpha Ensemble
Date/time UTC: 2026-09-10T01:10Z
Branch/commit: main / five focused commits, HEAD after P06-05

## What changed

The P6 Alpha Ensemble phase is complete: the frozen ensemble decision
contract with verbatim evidence preservation and component-version lineage
(P06-01, ADR-0018), the static per-regime weighting engine with WAIT-on-
conflict (P06-02), the cost-aware edge gate (P06-03), the confidence +
calibration layer (P06-04) and the deterministic decision ranking (P06-05).
The phase gate "Weighted ensemble + cost-aware decision gate" is satisfied
and `make check` is green.

### P06-01 — Ensemble decision contract (ADR-0018)
- `contracts/src/ensemble/contract.ts`: strict schemas — `EnsembleVote`
  (stance long/short/abstain, confidence, verbatim canonical Signal with
  its own snapshotHash when directional), `EnsembleWeightTable` (every
  regime state declared; empty allowed = fail-closed no-eligibility),
  `EnsembleCorrelationPenalty` (pair keys `a|b` ascending, correlations
  [-1,1], penaltyFactor [0,1], provenance source), `EnsembleCalibrationView`
  (null hit-rate requires sampleSize 0), `EnsembleConfidenceComponents`
  (voteAgreement, weightedAgreement, regimeAlignment, correlationPenalty,
  calibration), `EnsembleContribution` (per-strategy score decomposition),
  `EnsembleInput` and `EnsembleDecision` (final class enter_long /
  enter_short / wait). Frozen 9-code reason enum + 5-flag uncertainty enum.
  Deterministic `decisionId` (`ens_{instrument}_{timeframe}_{eventTimeUtc}`),
  sha256 `decisionHash` over `serializeEnsembleDecisionCanonical`.
  EVIDENCE NEVER HIDDEN: schema refinements force all input votes verbatim
  into the decision and contributions to mirror them; componentVersions
  records every component version.
- `backend/src/ensemble/builder.ts`: single construction path (derives id,
  hashes, validates — fail closed), mirroring the P05-01 signal builder.
- Python mirror `quant/ensemblecore/contract.py` (parse/serialize/sha256);
  parity pinned by committed `tests/fixtures/ensemble_parity.json`.

### P06-02 — Static baseline weighting
- `backend/src/ensemble/weighting.ts` + Python mirror `weighting.py`:
  regime-state resolution from the P04-03 context (fixed 1d > 4h > 1h
  precedence; all degraded -> `unknown` fail-closed), fixed per-regime
  weight lookup (missing strategy = weight 0, never missing-key
  improvisation), signed score decomposition
  (weight * confidence * stance), multiplicative correlation penalty, and
  the deterministic WAIT rules: no directional votes, BOTH sides carry
  mass (`conflicting_votes` — evidence conflict never trades), penalized
  mass below `minScore`, zero-weight regime (`regime_gate_rejected`),
  degraded context (`regime_context_degraded`). Dominant strategy = top
  contributor with lexicographic tie-break. Versioned config 1.0.0
  (minScore 0.3, minConfidence 0.2 — documented placeholders, NOT tuned).
- Engine parity fixture `tests/fixtures/ensemble_weighting_parity.json`
  (enter/conflict/gate/degraded sweep), asserted by the Python mirror.
- Contract note: the contribution zero-mass refinement was relaxed to
  "abstain must be 0" (a directional vote may contribute 0 when its
  resolved regime weight is 0) — the honest decomposition; field set,
  enums, id form and serialization unchanged (not a breaking change under
  ADR-0018).

### P06-03 — Cost-aware edge gate
- `backend/src/ensemble/edgeGate.ts` + Python mirror `edge_gate.py`:
  expected move from the dominant vote's take-profit distance (pips via
  instrument pip metadata), stop-distance context, round-trip cost floor
  (spread + 2*slippage) * minEdgeCostMultiple, net edge = move - floor.
  Insufficient net edge (strict `net > 0` boundary; values rounded to 6
  decimals for cross-layer-stable comparison) => WAIT +
  `cost_edge_below_minimum`. Enter without a target (no estimable edge)
  fails closed. WAIT pass-through; re-gating idempotent; gate version
  stamped in componentVersions. Cost inputs are EXPLICIT caller data —
  no fabricated production costs (non-goal honored).

### P06-04 — Confidence + calibration layer
- `backend/src/ensemble/calibration.ts` + Python mirror `calibration.py`:
  model confidence stays untouched; the empirical hit-rate
  (hits/total over recorded past outcomes) and its sample size are stamped
  into `confidenceComponents.calibration` — strictly separate fields, so
  UI/API can distinguish certainty from measured frequency (NEVER a win
  probability, NEVER a guarantee). Uncertainty flags: `no_calibration_data`
  (0 outcomes, plus `uncalibrated_confidence` reason code),
  `low_calibration_sample` (< minSampleSize 20 placeholder), carried-over
  conflict/stale markers preserved. Idempotent stamping through the single
  construction path.

### P06-05 — Decision ranking
- `backend/src/ensemble/ranking.ts` + Python mirror `ranking.py`:
  deterministic multi-factor score = expectedValue (net edge) x robustness
  (weighted agreement) x dataQuality (non-degraded context fraction) x
  freshness (linear decay to 0 at maxStaleBars behind `asOfUtc` — derived
  from closed-bar timestamps, NO wall clock) x portfolio redundancy
  (1 - worst same-direction correlation overlap above threshold 0.7;
  opposite directions hedge and are exempt). Stable order: score desc,
  then decisionId asc (unique deterministic tie-break); input order never
  changes the output. WAIT candidates rank last with an explicit reason
  and are never dropped. Config 1.0.0 (maxStaleBars 4 — placeholders).

## Files changed

- `contracts/src/ensemble/contract.ts` (new), `contracts/src/index.ts` (export)
- `contracts/src/__tests__/ensemble-contract.test.ts` (new)
- `backend/src/ensemble/builder.ts`, `weighting.ts`, `edgeGate.ts`,
  `calibration.ts`, `ranking.ts` (new)
- `backend/src/ensemble/__tests__/builder.test.ts`,
  `ensemble-parity-fixture.test.ts`, `weighting.test.ts`,
  `weighting-parity-fixture.test.ts`, `edgeGate.test.ts`,
  `calibration.test.ts`, `ranking.test.ts` (new)
- `quant/ensemblecore/__init__.py`, `contract.py`, `weighting.py`,
  `edge_gate.py`, `calibration.py`, `ranking.py` (new)
- `tests/fixtures/ensemble_parity.json`, `ensemble_weighting_parity.json` (new)
- `tests/test_ensemble_contract_contracts.py`,
  `test_ensemble_weighting_contracts.py`,
  `test_ensemble_edge_gate_contracts.py`,
  `test_ensemble_calibration_contracts.py`,
  `test_ensemble_ranking_contracts.py` (new)
- `docs/adr/ADR-0018-ensemble-decision-contract-and-evidence-preservation.md`
  (new), `docs/adr/README.md` (index), `tests/test_ci_contracts.py`
  (KNOWN_ADRS + ADR-0018)

## Tests executed

- `contracts` vitest: 107 tests pass (17 new ensemble contract cases).
- `backend` vitest: 386 tests pass (43 files; 41 new ensemble cases:
  builder 4, contract parity 1, weighting 13, edge gate 8, calibration 8,
  ranking 11 — including the two fixture-writer tests).
- Python stdlib: 91 ensemble tests pass (28 contract + 14 weighting +
  10 edge gate + 11 calibration + 10 ranking + parity), plus the full
  `tests/` suite (378) green after fixing the safety-scanner regression
  (word "broker" in a weighting.ts comment — same class of regression the
  P05 report documented; scanner caught it, comment reworded, re-verified).
- `pnpm lint` + `pnpm typecheck` clean in contracts, backend and frontend.
- `make check` (lint + typecheck + test + build) green at phase end.

## Acceptance criteria

- [x] P06-01: the ensemble never hides individual strategy evidence —
      schema-enforced: all votes carried verbatim, contributions mirror
      votes, unsorted/duplicated votes reject. All component versions
      recorded (componentVersions + weightsVersion + ensembleVersion).
- [x] P06-02: fixtures prove deterministic decisions (idempotency +
      decisionHash equality asserted in both languages) and explainable
      score decomposition (per-strategy weight/confidence/contribution
      asserted against exact values); WAIT emitted for evidence conflict.
- [x] P06-03: signals with insufficient net edge become WAIT with the
      explicit `cost_edge_below_minimum` reason code (strict boundary test
      included); no fabricated cost assumptions — costs are explicit
      caller-supplied config.
- [x] P06-04: UI/API can distinguish confidence (untouched model
      certainty), empirical hit-rate (separate field), sample size and
      uncertainty flags (no_calibration_data / low_calibration_sample +
      carried markers); uncalibrated_confidence reason when no data.
- [x] P06-05: scanner receives stable ranking keys — score desc with
      deterministic decisionId-ascending tie-break, input-order
      independent; WAIT never dropped; stale/zero-quality candidates score
      0 with explicit reasons.
- [x] Relevant tests pass — `make check` green.
- [x] Lint/typecheck/build clean for all affected packages.
- [x] No unrelated files modified (ADR registry + CI KNOWN_ADRS updates
      follow the established per-ADR pattern; the safety-scanner comment
      fix is an in-scope regression fix).
- [x] Completion report written — `02_REPORTS/P06_COMPLETION_REPORT.md`,
      mirrored in root `COMPLETION_REPORT.md` (P05 precedent).

## Known limitations / blockers

- All thresholds (minScore 0.3, minConfidence 0.2, minEdgeCostMultiple 2,
  minSampleSize 20, maxStaleBars 4, redundancyThreshold 0.7) and the
  default weight table are documented placeholders — NO tuning before the
  P8 backtest harness and P9 validation gates are stable (ADR-0016/0017).
- Cost model inputs (spread/slippage) are caller-supplied in pips; the
  full transaction-cost model (latency, fills, observed per-instrument
  spreads from quotes) belongs to P8. No fabricated defaults are wired.
- The conflict rule is strict (both sides carrying mass blocks entries);
  a graded conflict policy can be introduced later via config versioning
  without a contract change.
- Ranking correlations are explicit per-candidate inputs; the
  instrument-correlation matrix product (estimated from returns) is a
  research data product (P9/P12), not invented here.
- Calibration outcomes are supplied records; the outcome-tracking loop
  (signal -> resolved outcome store) lands with P12 analytics.

## Follow-up required before next prompt

None blocking. P6 phase gate ("ensemble, cost/edge gate and explainable
decision object") is satisfied.

## Risk notes

Quant: all timestamps UTC; the ensemble is a pure function of its closed
inputs (no wall clock — freshness derives from the as-of closed bar; no
randomness); deterministic ids + canonical sha256 hashing make
re-evaluation idempotent; TS<->Python parity pinned by committed fixtures
(decision serialization, engine sweep). No look-ahead: votes derive from
closed bars only; calibration outcomes are past records. Confidence is
certainty in [0,1]; the empirical hit-rate is a measured frequency;
neither is ever a win probability or profit guarantee; no guarantee
language anywhere. Security: no secrets in source, fixtures or logs; all
boundary inputs validated fail-closed (zod / strict Python parsers).
Trading safety: no ensemble, gate, calibration or ranking code calls any
execution path; the pipeline output remains a decision object consumed by
risk in a later phase; live execution stays OFF (ADR-0005); risk hard
limits remain independent and authoritative (blueprint).

## Next prompt (safe to run)

`01_PROMPTS/P07_Signal_UX/` — command center, scanner, signal detail and
alerts, per `00_CONTROL/RUN_ORDER.md` (P6 gate passed).

