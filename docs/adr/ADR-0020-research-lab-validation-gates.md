# ADR-0020: Research-lab validation gates and promotion registry

- Status: Accepted
- Date: 2026-09-11 (UTC)
- Deciders: FdbTrade owner (blueprint v2 approval), Cline agent
- Supersedes: none
- Related: ADR-0019 (backtest engine), ADR-0017 (strategy/signal contract), ADR-0018 (ensemble decisions)

## Context

Phase P9 needs validation gates between backtest results and any future
promotion/optimization: time-aware splits, walk-forward evaluation,
purged/embargoed validation, stress/Monte Carlo diagnostics and a
promotion registry. P8 froze the engine, costs, metrics and golden runs —
P9 consumes only those frozen surfaces and adds no execution authority.

## Decision

1. Time splits (P09-01) live in `contracts/src/research/splits.ts`
   (Python mirror `quant/research/splits.py`): deterministic
   train/validate/test partition with explicit purge gaps; floor sizing
   with leftover bars to TEST; canonical serialization for hashing.
2. Walk-forward (P09-02) lives in `contracts/src/research/walkforward.ts`
   (mirror `quant/research/walkforward.py`) plus the engine runner
   `backend/src/research/walkforwardRunner.ts`: rolling/expanding folds,
   forward-only, non-overlapping tests, per-fold metrics summary.
3. Purge/embargo (P09-03) lives in `contracts/src/research/purge.ts`
   (mirror `quant/research/purge.py`): horizon-based train purge plus a
   post-test embargo tail; pure index math.
4. Stress/Monte Carlo (P09-04) lives in `contracts/src/research/stress.ts`
   (mirror `quant/research/stress.py`): multiplier-resolved scenarios
   labeled `stressed`, FNV-1a/LCG seeded shuffle shared across TS/Python,
   block-reshuffle drawdown Monte Carlo.
5. Promotion registry (P09-05) lives in
   `contracts/src/research/promotion.ts` (mirror
   `quant/research/promotion.py`): candidate/challenger/champion lifecycle
   with evidence gates and append-only transitions; terminal states absorb.
6. The registry has no order authority (ADR-0005 upheld); promotion is a
   research label, never an execution trigger.

## Consequences

- Every promotion decision pins split/walk-forward/purge/stress hashes as
  evidence; auditors can replay the exact validation inputs.
- Later phases (P10 paper, P11 risk) consume champion labels only through
  explicit gates; nothing auto-trades on promotion.
- Cross-layer parity (TS/Python canonical strings, shuffle permutations)
   is pinned by tests on both sides.

## Verification

- `contracts` vitest: research-lab suites A/B (splits, walk-forward,
  purge, stress, promotion happy paths + fail-closed + determinism).
- `backend` vitest: walk-forward runner (fold slicing over the P08
  engine, candle/barCount mismatch gate).
- Python stdlib: `tests/test_research_lab.py` mirrors every suite
  including byte-exact canonical serializations.
- `make check` green.
