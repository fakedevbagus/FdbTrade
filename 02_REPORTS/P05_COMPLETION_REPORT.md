# Completion Report

Prompt ID: P05_Strategy_Core (P05-01 through P05-06, executed in required order)
Phase: P5 Strategy Core
Date/time UTC: 2026-09-09T19:45Z
Branch/commit: main / six focused commits, HEAD at 23f1852

## What changed

The P5 Strategy Core phase is complete: the canonical strategy
interface and signal contract v2 with full lineage (P05-01), four
deterministic baseline strategies — trend-following pullback (P05-02),
range/volatility breakout (P05-03), mean-reversion (P05-04), MTF
momentum (P05-05) — and the signal lifecycle with expiry (P05-06). The
phase gate "2-5 baseline strategies and canonical signal contract" is
satisfied (4 strategies + contract) and `make check` is green.

### P05-01 — Strategy interface + signal contract v2 (ADR-0017)
- `contracts/src/strategy/contract.ts`: strict `signalSchema` —
  direction (`long`/`short`), entry types (`market`/`stop`/`limit` with
  mandatory `entryPrice` for resting entries), MANDATORY `stopLoss`
  (a signal without an invalidation level is invalid by construction),
  optional `takeProfit`, direction-consistent levels
  (long: stop below / target above `entryPrice ?? referencePrice`;
  short mirrored), grid-aligned `eventTimeUtc` and `expiresAtUtc`
  (strictly future), deterministic `signalId`
  (`sig_{strategyId}_{instrument}_{timeframe}_{eventTimeUtc}_{direction}`),
  sha256 `snapshotHash`, sorted unique reason codes, full input lineage,
  frozen 26-code reason enum. `confidence` in [0,1] is strategy
  certainty — never a win probability.
- `contracts/src/strategy/interface.ts`: `StrategyInputSnapshot`
  (closed-world: instrument metadata, one timeframe, strictly
  ascending CONTIGUOUS closed candles ending exactly at `eventTimeUtc`,
  P04-03 regime context), `StrategyEvaluation` envelope (at most one
  signal; no-signal is a first-class explained outcome) and the pure
  `Strategy` interface (id, logic semver, config semver, timeframe,
  typed config, `evaluate`).
- `backend/src/strategy/builder.ts`: single construction path — derives
  `signalId`, hashes `serializeSignalCanonical`, validates against the
  schema (fail closed).
- Python mirror `quant/strategycore/contract.py` (parse, strict
  reason-code ordering, canonical serialization + sha256); parity pinned
  by committed `tests/fixtures/signal_parity.json`.

### P05-02 — Trend-following baseline
- `backend/src/strategy/trendPullback.ts` + Python mirror: HTF trend
  regime gate, EMA fast/mid/slow stack, ADX strength filter, ATR/close
  volatility band, pullback-resumption confirmation (recent bars tagged
  the fast EMA, current bar closed back beyond it), swing-based
  invalidation (window extreme padded by stopPadAtr*ATR) and
  reward-multiple target. Versioned config `1.0.0`; placeholders NOT
  tuned (ADR-0016/0017 rule).
- Fixtures: uptrend+pullback (long), downtrend+rally (short), warmup,
  broken stack, regime/missing-context rejections; determinism,
  idempotency, prefix-truncation + future-append no-look-ahead proofs.
- Parity fixture `tests/fixtures/trend_parity.json` (sweep of prefixes,
  both outcomes present).

### P05-03 — Breakout baseline
- `backend/src/strategy/breakout.ts` + mirror: HTF gate (trend regime
  REJECTS — breakout is the range edge), prior-window compression
  (range width <= maxRangeAtr*ATR), dead-market ATR floor,
  CLOSE-confirmed break beyond the extreme (wick-only poke = fakeout
  reject), invalidation beyond the opposite range edge + padded stop.
- Fixtures: breakout long/short, fakeout (high wick, close inside),
  low-volatility, uncompressed window, trend-regime reject, warmup;
  determinism/no-look-ahead; parity fixture
  `tests/fixtures/breakout_parity.json`.

### P05-04 — Mean-reversion baseline
- `backend/src/strategy/meanReversion.ts` + mirror: HTF gate (trend and
  high_volatility reject), ATR/close band, z-score of the last close
  against STRICTLY PRIOR bars (no self-inclusion), |z| >= zEntry fade,
  mean-target exit, invalidation beyond the window extreme. NO
  martingale/grid knobs by design.
- Fixtures: overextension long/short, inside-range, trend/high-vol
  regime reject, degenerate distribution, warmup; determinism,
  no-look-ahead; parity fixture
  `tests/fixtures/mean_reversion_parity.json`. Mirror uses plain
  left-to-right accumulation (Python `sum()` Neumaier-compensates and
  diverged from the TS `+=` loop at the last bit — pinned by parity).

### P05-05 — Momentum baseline
- `backend/src/strategy/momentum.ts` + mirror: HTF trend gate, fast/
  slow momentum alignment (disagreement = exhaustion risk),
  blow-off exhaustion filter (|fast momentum|/ATR cap), closing
  confirmation, and the COST-AWARE MINIMUM EDGE: reward pips must
  exceed `(spread + 2*slippage) * minEdgeCostMultiple` — cost-eaten
  setups reject (`edge_below_costs`). Cost inputs are explicit config
  (pip from instrument metadata, never literals).
- Fixtures: continuation long/short, exhaustion (blow-off),
  misalignment, cost-floor reject, regime reject, warmup; determinism,
  no-look-ahead; parity fixture `tests/fixtures/momentum_parity.json`.

### P05-06 — Signal lifecycle + expiry
- `contracts/src/strategy/lifecycle.ts`: frozen states
  `active`/`expired`/`invalidated`/`closed`; terminal states absorbing;
  append-only `SignalTransition` log (deterministic bar-OPEN `atUtc`,
  never a wall clock); expiry checked FIRST (earlier deterministic
  death wins on a tie bar); invalidation = closed bar touching the
  stop; closure is an input event from the execution layer (the engine
  never closes on its own; NO order creation). `applyTransition` is
  idempotent (same to+atUtc event = no-op), fail-closed on from-state
  mismatch, non-ascending timestamps, wrong signalId.
- Python mirror `quant/strategycore/lifecycle.py` (same rule order and
  idempotency-first ordering).
- Regression: the API safety scanner caught a forbidden `broker` token
  in strategy source comments (same class as the P04-04 finding);
  comments reworded, scanner test re-verified green.

## Files changed

- contracts: `src/strategy/contract.ts`, `src/strategy/interface.ts`,
  `src/strategy/lifecycle.ts`, `src/index.ts`,
  `src/__tests__/strategy-contract.test.ts`,
  `src/__tests__/strategy-lifecycle.test.ts`
- backend: `src/strategy/builder.ts`, `src/strategy/trendPullback.ts`,
  `src/strategy/breakout.ts`, `src/strategy/meanReversion.ts`,
  `src/strategy/momentum.ts` + six test files under
  `src/strategy/__tests__/`
- quant: `strategycore/{__init__,contract,trend_pullback,breakout,
  mean_reversion,momentum,lifecycle}.py`
- tests: `test_strategy_{contract,trend,breakout,mean_reversion,
  momentum,lifecycle}_contracts.py`; fixtures `signal_parity.json`,
  `trend_parity.json`, `breakout_parity.json`,
  `mean_reversion_parity.json`, `momentum_parity.json`
- docs: `ADR-0017-canonical-strategy-interface-and-signal-contract.md`,
  ADR README index, `tests/test_ci_contracts.py` ADR registry (17)

## Tests executed

- `make check` (lint + typecheck + test + build, all packages): green
  (EXIT=0).
- Contracts vitest: 90 tests (30 new: 21 signal contract + 9 lifecycle).
- Backend vitest: 340 tests (new strategy-layer suites: builder 5,
  trend 12, breakout 13, mean-reversion 12, momentum 13 + 4 parity
  fixture writers, replacing none).
- Python stdlib: 336 tests (60 new across 6 strategy files incl. all
  parity fixtures).
- Cross-layer parity: five committed fixtures pin TS<->Python
  signal-contract and strategy-decision parity exactly (states,
  directions, reason codes, levels, inputs, hashes).
- No-look-ahead: every strategy suite includes prefix-truncation and
  future-append invariance proofs; evaluation envelopes are
  deterministic and idempotent for identical snapshots.


## Acceptance criteria

- [x] P05-01: strategies are pure/deterministic against an input
      snapshot; contract validation rejects invalid signals (strict
      schema + 21 contracts + 16 Python cases).
- [x] P05-02: trend baseline has fixtures, expected signals,
      no-look-ahead tests and a versioned config (determinism +
      truncation proofs; parity fixture).
- [x] P05-03: fixture tests cover breakout, fakeout and low-volatility
      conditions (close-confirmation rejects wick-only fakeouts;
      ATR floor rejects dead markets; uncompressed windows reject).
- [x] P05-04: fixture tests cover overextension, trend regime
      rejection and exit conditions (mean-target exit + window-extreme
      invalidation asserted; no martingale/grid anywhere).
- [x] P05-05: fixture tests cover momentum continuation and exhaustion
      cases; cost-aware minimum edge enforced (edge_below_costs).
- [x] P05-06: a signal can be traced through lifecycle transitions with
      deterministic timestamps (append-only log, expiry boundary exact,
      idempotent re-application, absorbing terminal states).
- [x] Relevant tests pass from a clean environment — `make check` green.
- [x] Lint/typecheck/build clean for affected packages.
- [x] No unrelated files modified without justification (ADR registry +
      index updates follow the established per-ADR pattern; the
      safety-scanner comment fix is an in-scope regression fix).
- [x] Completion report written — this file (root
      `COMPLETION_REPORT.md` mirrors this summary, following the P04
      precedent).

## Known limitations / blockers

- All strategy thresholds are documented baseline placeholders (per
  ADR-0016/0017): NO parameter tuning until the P8 backtest harness and
  P9 validation gates are stable.
- The momentum cost floor is a strategy-side sanity check on spread +
  slippage only; the full transaction-cost model (latency, fill
  assumptions, per-instrument spreads) belongs to P8.
- Strategies are in-process pure functions; wiring them to live
  snapshot stores and an ensemble consumer is P6 scope.
- Lifecycle invalidation uses closed-bar high/low touch of the stop
  level (bar-granular); intrabar sequence (stop vs target within one
  bar) is unresolved at this granularity — P8 must state fill
  assumptions explicitly.
- Signals carry `confidence` 0.5 in the baselines — meaningful
  calibration requires P6 ensemble + P12 analytics; never treated as a
  win probability.

## Follow-up required before next prompt

None blocking. P5 phase gate ("2-5 baseline strategies and canonical
signal contract") is satisfied with four baselines + the contract.

## Risk notes

Quant: all timestamps UTC; bar-OPEN semantics preserved end to end;
every strategy is a pure function of the closed snapshot — no
look-ahead (proved per strategy by prefix-truncation and future-append
invariance), no wall clock, no randomness; deterministic signal ids
make re-evaluation idempotent; TS<->Python parity pinned by committed
fixtures; the Python mirrors deliberately avoid compensated summation
where TS uses plain accumulation, so parity holds bit-for-bit.
Confidence fields are certainty scores in [0,1], never win
probabilities; no profit guarantee is expressed or implied.
Security: no secrets in source, fixtures, logs or bundles; all inputs
validated fail-closed at boundaries; the API safety scanner regression
(forbidden broker token in strategy source comments) was caught by the
existing CI contract test, fixed and re-verified. Trading safety: no
strategy, feature or lifecycle code calls any execution path; the
lifecycle engine never closes a signal on its own and creates no
orders; live execution remains OFF (ADR-0005); risk hard limits remain
authoritative and independent of strategies (blueprint).

## Next prompt (safe to run)

`01_PROMPTS/P06_Alpha_Ensemble/` — ensemble, cost/edge gate and the
explainable decision object, per `00_CONTROL/RUN_ORDER.md` (P5 gate
passed).

