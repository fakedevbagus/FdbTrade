# Completion Report

Prompt ID: P09_Research_Lab (P09-01 through P09-05, executed in required order)
Phase: P9 Research Lab
Date/time UTC: 2026-09-11T15:00Z
Branch/commit: main / P09 research-lab commit (this change)

## What changed

The P9 Research Lab phase is complete: deterministic time splits (P09-01),
walk-forward evaluation over the frozen P08 engine (P09-02), purged/embargoed
validation index math (P09-03), stress scenarios + seeded Monte Carlo
diagnostics with historical/stressed labeling (P09-04), and the strategy
promotion registry with evidence gates (P09-05). ADR-0020 recorded.
Lint + typecheck + full test suites + build are green for every package
(Python suite: 476 tests OK).

### P09-01 - Deterministic time splits (ADR-0020 section 1)
- `contracts/src/research/splits.ts`: strict schemas (range/request/plan),
  `planResearchSplit` (floor train/validate sizes, leftover bars to TEST,
  gaps carved AFTER sizing), `barsOfSection`, byte-identical canonical
  serialization for hashing. Fail-closed on ratio sums != 1, empty
  sections, and starvation by gaps/minSectionBars.
- Python mirror `quant/research/splits.py` (same planner semantics, same
  canonical string, verified byte-identical by tests).

### P09-02 - Walk-forward evaluation (ADR-0020 section 2)
- `contracts/src/research/walkforward.ts`: rolling/expanding folds,
  forward-only, non-overlapping test segments, purged gap bars between
  train and test, `minFolds` gate, canonical serialization.
- `backend/src/research/walkforwardRunner.ts`: fold slicing over the P08
  engine (fold-scoped run configs keep the full attribution chain;
  closed-world slices per fold - no look-ahead across folds), per-fold
  metrics + median-OOS-net-return / worst-drawdown summary. No
  optimization - one fixed subject per call.
- Python mirror `quant/research/walkforward.py`.

### P09-03 - Purged/embargoed validation (ADR-0020 section 3)
- `contracts/src/research/purge.ts` (+ mirror `quant/research/purge.py`):
  horizon-based train purge (bars whose [bar, bar+horizonBars) label
  window touches the test range are dropped) plus the post-test embargo
  tail (embargoBars after each test range). Pure deterministic index math;
  forward-only gate enforced.

### P09-04 - Stress testing + Monte Carlo (ADR-0020 section 4)
- `contracts/src/research/stress.ts` (+ mirror `quant/research/stress.py`):
  multiplier-resolved scenarios (spread/slippage/commission multipliers +
  extra latency bars) always labeled `stressed`; historical results stay
  `historical` so the two can never be confused. Shared FNV-1a + LCG
  `seededShuffle` produces the SAME permutation in TS and Python;
  cumulative-path max drawdown and block-reshuffle Monte Carlo with
  sample bounds (1..10000) and full seed provenance.

### P09-05 - Strategy promotion registry (ADR-0020 section 5)
- `contracts/src/research/promotion.ts` (+ mirror
  `quant/research/promotion.py`): candidate -> challenger -> champion
  lifecycle with rejected/retired absorbing terminals. Promotion to
  challenger/champion requires the sha256-pinned evidence bundle (split /
  walk-forward / purge / stress hashes + OOS metrics); transitions are
  append-only and strictly UTC-ascending; the rollback pointer
  (`previousChampionId`) records the prior champion. No order authority
  anywhere (ADR-0005 upheld) - promotion is a research label, never an
  execution trigger.

## Files changed

- `contracts/src/research/` (new): `splits.ts`, `walkforward.ts`,
  `purge.ts`, `stress.ts`, `promotion.ts`
- `contracts/src/index.ts` (research barrel exports)
- `contracts/src/__tests__/research-lab-a.test.ts` (new: 4 tests),
  `research-lab-b.test.ts` (new: 5 tests)
- `quant/research/` (new): `__init__.py`, `splits.py`, `walkforward.py`,
  `purge.py`, `stress.py`, `promotion.py`
- `quant/README.md` (research section)
- `backend/src/research/walkforwardRunner.ts` (new),
  `backend/src/research/__tests__/walkforward.test.ts` (new: 2 tests)
- `tests/test_research_lab.py` (new: 10 tests)
- `tests/test_ci_contracts.py` (KNOWN_ADRS + ADR-0020 entry)
- `docs/adr/ADR-0020-research-lab-validation-gates.md` (new),
  `docs/adr/README.md` (index)
- `COMPLETION_REPORT.md` (this report)

## Tests executed

- `python3 -m unittest discover -s tests -p 'test_*.py'`: 476 tests, OK
  (includes the new `test_research_lab` 10/10 and the updated
  `test_ci_contracts` ADR gate).
- `contracts` vitest: 11 files / 122 tests passed (includes
  research-lab-a 4/4 and research-lab-b 5/5).
- `backend` vitest: 61 files / 538 tests passed (includes the walk-forward
  runner 2/2).
- `pnpm -r run lint`: clean. `pnpm -r run typecheck`: clean.
  `pnpm -r run build`: clean (Next build with all API routes).

## Acceptance criteria

- [x] P09-01: deterministic, non-overlapping, chronological splits with
      configurable gaps; golden boundaries hand-checked; malformed input
      fails closed.
- [x] P09-02: rolling/expanding walk-forward over the frozen engine with
      per-fold metrics and a reproducible summary; no look-ahead across
      folds (closed-world slices proven by tests).
- [x] P09-03: purge/embargo drops horizon-leaking bars deterministically;
      the forward-only gate is enforced.
- [x] P09-04: stress scenarios resolve explicit cost/latency assumptions
      and are labeled `stressed`; Monte Carlo is seeded/deterministic with
      drawdown diagnostics; historical vs stressed can never be confused.
- [x] P09-05: promotion requires pinned evidence; the lifecycle has no
      skips or resurrections; rollback pointer recorded; no execution
      authority (ADR-0005).
- [x] Relevant tests pass from a clean environment; lint/typecheck/build
      clean; no unrelated files modified.
- [x] Completion report written (this file).

## Known limitations / blockers

- The walk-forward runner evaluates TEST folds only; the train-range
  fitting step is a future concern (no optimizer exists yet by design -
  the blueprint forbids optimization before the validation gates are
  stable).
- Monte Carlo reshuffles per-trade PnL blocks; full equity-path
  resampling with per-fill cost re-application is future work.
- Seeds are recorded provenance; the deterministic core consumes them
  only through the documented FNV/LCG shuffle stream.
- The P09 contracts are library-level (splits/walk-forward/purge/stress
  are pure functions); no new HTTP endpoints were added - the P08 API
  boundary is untouched.

## Follow-up required before next prompt

None blocking. The P9 phase gate ("WFO/OOS/stress/Monte Carlo and
promotion registry") is satisfied.

## Risk notes

Quant: forward-only everywhere (splits, folds, purge); gaps/embargoes are
counted in explicit bars, never invented; costs stay mandatory underneath
(the walk-forward runner drives the P08 engine with real fill policies);
metrics emit nulls, never fabricated numbers; stressed outputs cannot
masquerade as historical (kind label). Security: no secrets in source or
fixtures; strict zod/datacore validation at every boundary; the CI ADR
gate was updated for ADR-0020. Trading safety: research never contacts an
execution layer (ADR-0003/0005); promotion is a label, not a trigger;
live execution remains OFF.

## Next prompt (safe to run)

P10 Paper Broker - realistic paper broker and reconciliation, per
`00_CONTROL/RUN_ORDER.md` (P9 gate passed).
