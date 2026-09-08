# ADR-0016: Deterministic rule-based regime engine

- Status: Accepted
- Date: 2026-09-09 (UTC)
- Deciders: FdbTrade owner (blueprint v2 approval), Cline agent
- Supersedes: none
- Related: ADR-0003 (architecture boundaries), ADR-0004 (UTC policy), ADR-0014 (feature definitions), ADR-0015 (snapshot store)

## Context

Prompt phase P4 requires a deterministic regime engine: canonical regime
states, a rule-based baseline classifier over P3 features, multi-timeframe
context without future leakage, and diagnostics for the research dashboard.
P5 strategies consume regimes downstream; per ADR-0003 the regime engine is
a pure data component — it must never call a broker, and strategy code must
never bypass signal/risk boundaries. No ML and no threshold tuning are
allowed in this phase.

## Decision

1. Canonical regime states are frozen: `trend`, `range`, `high_volatility`,
   `low_volatility`, `transition`, `unknown` (`contracts/src/regime/contract.ts`,
   Python mirror `quant/regimecore/contract.py`). Degraded states
   (`unknown`, `transition`) are first-class.
2. A `RegimeAssessment` is a strict, schema-validated record: instrument,
   timeframe, UTC bar-OPEN event time (ADR-0004 semantics), state,
   confidence in [0,1], sorted unique reason codes, classifier id + semver
   version and the feature inputs used. `confidence` is classifier
   certainty — never a win probability.
3. Fail-closed degradation: an `unknown` assessment requires confidence
   exactly 0 and at least one degradation reason code
   (`insufficient_history`, `missing_feature`, `stale_context`,
   `missing_context`); degradation codes are forbidden on non-unknown
   states. Missing/stale inputs never invent a state.
4. The baseline classifier (`backend/src/regime/classifier.ts`, mirror
   `quant/regimecore/classifier.py`) is deterministic and rule-based over
   P03 features (ADX trend strength, ATR-fraction volatility, pip-slope
   structure). Rule order: volatility extremes (rolling prior-bar baseline
   ratio) → trend (ADX + slope confirmation) → range (low ADX) →
   transition (dead zone or unconfirmed trend). The volatility baseline
   uses strictly PRIOR bars — no self-inclusion, no look-ahead (proven by
   prefix-truncation tests).
5. Default thresholds (volWindow 50, highVolRatio 1.5, lowVolRatio 0.6,
   trendAdx 25, rangeAdx 20, minSlopePips 0.5) are documented baseline
   placeholders. Tuning is forbidden until the backtest harness and
   validation gates (P8/P9) are stable.
6. Multi-timeframe context (`backend/src/regime/context.ts`, mirror
   `quant/regimecore/context.py`): a higher-timeframe (1h/4h/1d) assessment
   is usable for a lower-timeframe event time ONLY when that HTF bar has
   CLOSED (bar open + timeframe duration <= event time). Stale or missing
   HTF context degrades to `unknown` with `stale_context` /
   `missing_context` — never to the latest known state.
7. Diagnostics (`backend/src/regime/diagnostics.ts`, mirror
   `quant/regimecore/diagnostics.py`) is a pure read model over assessment
   series: state distribution, transition counts, episode persistence and
   deterministic quality flags. It mutates nothing.
8. TS/Python parity for the classifier is pinned by a committed,
   deterministically regenerated fixture (`tests/fixtures/regime_parity.json`),
   following the P03 indicator-parity precedent.

## Consequences

- P5 strategies receive regimes only through this contract; direction and
  trade decisions remain strategy-side.
- Changing the state set, degradation rules or threshold defaults requires
  a new classifier version and a superseding decision — historical
  assessments stay reproducible.
- The engine stays a pure data component; no broker or order-path coupling.

## Verification

- `contracts` vitest: schema valid/malformed/boundary cases.
- `backend` vitest: classifier fixtures (trend/range/vol/transition/unknown),
  determinism, warmup, no-look-ahead truncation, MTF boundary correctness,
  diagnostics math.
- Python stdlib tests: contract parsing, mirror parity against the committed
  fixture, context and diagnostics behavior.
- `make check` green.
