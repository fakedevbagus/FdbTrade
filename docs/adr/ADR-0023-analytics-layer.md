# ADR-0023: Analytics layer for trade outcomes, calibration, MAE/MFE and attribution

- Status: Accepted
- Date: 2026-09-11 (UTC)
- Deciders: FdbTrade owner (approved via P12 prompt pack)
- Supersedes: none
- Related: ADR-0003 (architecture boundaries), ADR-0004 (UTC), ADR-0005 (live OFF), ADR-0017 (signal contract), ADR-0018 (ensemble), ADR-0019 (backtest engine), ADR-0021 (paper broker), ADR-0022 (risk engine)

## Context

The frozen blueprint's P12 phase requires analytics over realized trading
outcomes: expectancy, average R, win/loss distribution, drawdown and
recovery time (P12-01); Brier/log-loss calibration with reliability bins
and sample-size status (P12-02); MAE/MFE by strategy, instrument, regime
and confidence bucket (P12-03); and attribution to strategy components,
regime, session, direction, symbol and portfolio factors with PnL
reconciliation (P12-04). P08 backtest positions and P10 paper positions
already carry full signal lineage, realized PnL and excursion data; the
analytics layer must consume those contracts without weakening any earlier
gate, must stay deterministic, must never claim confidence equals win
probability, and must never mutate strategy rules or touch a broker.

## Decision

1. The analytics layer lives in `contracts/src/analytics/` as pure, typed,
   zod-validated TS modules (same pattern as P10 paper/P11 risk): `util.ts`
   (rounding/epsilon), `outcome.ts` (trade records + outcome metrics),
   `calibration.ts`, `maeMfe.ts`, `attribution.ts`. It imports upstream
   contracts only (backtest, paper, regime, strategy, marketdata) and never
   contacts a broker, strategy runtime or provider (ADR-0003/0005).
2. `AnalyticsTradeRecord` is the canonical closed-trade input. Builders
   `tradeRecordFromBacktest(position, intent)` and
   `tradeRecordFromPaper(order, position, exitReason)` verify lineage
   (intentId / instrument) and fail closed on open positions. `rMultiple`
   is COMPUTED (`round6(realizedPnl / plannedRisk)`) and pinned by a schema
   refine — a caller-supplied inconsistent R cannot cross the boundary.
   `plannedRisk`/`rMultiple`/`regimeState`/`confidence` are null when not
   recorded; analytics degrade to the recorded subsample, never to 0.
3. One `pnlCurrency` per computation; mixed-currency input throws
   (`AnalyticsError`). Trades are ordered by `exitAtUtc` (tie-break
   `tradeId`) before any cumulative math. Drawdown episodes are computed
   on the cumulative closed-trade PnL curve: an episode runs peak ->
   trough -> first return to (>=) the peak; a trailing below-peak curve
   stays `recoveredAtUtc: null`. Recovery is reported both in trades and
   milliseconds (`recoveryTimeMs`).
4. `AnalyticsTradeFilter` (strategy, instrument, timeframe, regime,
   direction — all optional, inclusive, AND-combined) is shared by all
   four reports; the exact applied filter is echoed in every report so
   metrics are always attributable to a population.

5. Calibration (`P12-02`): `CalibrationObservation` pairs a forecast
   probability with the realized binary outcome of the same trade.
   `calibrationObservationFromTrade` derives the probability from the
   record's `confidence` (a certainty score — the layer MEASURES its
   empirical relationship to outcomes and never claims it is a win
   probability). Brier = mean (p-y)^2; log-loss = mean cross-entropy with
   probabilities clamped to `[epsilon, 1-epsilon]` (epsilon 1e-12,
   recorded in the report — p=0/1 can never yield Infinity). Reliability
   bins use FROZEN edges [0, 0.2, 0.4, 0.6, 0.8, 1] (upper-exclusive
   except the last). Every bin and the whole sample carry a
   `sampleStatus`: `insufficient` below `minBinSample` (default 10),
   `stable` at/above it — thin evidence is machine-readable, never mixed
   silently into a "stable" estimate.
6. MAE/MFE (`P12-03`): `computeExcursionSummary` groups trades by strategy,
   instrument, regime or confidence bucket. Confidence buckets are frozen
   deciles `c00..c09` + `unknown` (null confidence — never fabricated into
   a numeric bucket). Trades with both excursions 0 carry no excursion
   data (the P10 ledger path without caller-supplied excursions) and are
   counted as `excursionMissingCount`, excluded from excursion averages.
   `meanMfeEfficiency` (realized R / MFE-in-R) is computed only when
   planned risk is recorded; otherwise null. The summary is a pure
   projection — no strategy-rule writes (non-goal pinned by test).
7. Attribution (`P12-04`): attribution is EXCLUSIVE per dimension — every
   trade lands in exactly one group per dimension, so no double-counting.
   The frozen dimension set is strategy, strategyVersion
   (`strategy@version`), regime (null => `unattributed`), session,
   direction, instrument, portfolioFactor (recorded-at-trade-time tag;
   absent => `unattributed`, never invented). Session labels are a FROZEN
   UTC-hour analytics convention (asia 00-07, london 07-12, overlap 12-16,
   newyork 16-21, offhours 21-24, upper-exclusive) — an analytics label,
   NOT provider session metadata (constitution keeps true session
   semantics in market-data metadata). Each slice embeds reconciliation:
   `attributedPnl` vs the aggregate `totalPnl` within `tolerance`
   (default 1e-6, the 6-decimal money-storage scale), with
   `reconciliationGap` and a boolean recorded on the slice and the report.
8. All reports are pure functions of their inputs: no wall clock, no
   randomness, no I/O. Deterministic for deterministic inputs (pinned by
   idempotency tests that shuffle input order and require byte-identical
   reports).

## Consequences

- The contracts package remains the single source of truth; backend/API
  wiring, persistence and dashboards land in later prompts (P13+ for
  observability surfaces). The analytics functions are ready for that
  wiring without schema churn.
- The paper path requires the caller to supply excursions and the exit
  reason (the P10 ledger tracks neither); the builders make that explicit
  instead of fabricating data.
- The MAE-efficiency metric was cut from the frozen schema (its input,
  stop distance in pips, is not on the trade record and would have to be
  fabricated); MFE capture efficiency remains, computed only from
  recorded data. Adding stop-distance to the record requires a contract
  change in a later prompt, not a silent extension.
- Session attribution is hour-based; DST-accurate session semantics would
  require provider metadata joins and are deliberately out of scope.
- Log-loss clamping means a 1e-12 floor on probabilities; scores are
  comparable across runs because epsilon is recorded in every report.
- Follow-on: Python mirrors are NOT required by P12 scope (analytics is a
  TS contracts layer, like P11 risk); a mirror becomes relevant only when
  research pipelines need the metrics.

## Verification

- `pnpm --filter @fdbtrade/contracts run typecheck` (0 errors)
- `pnpm --filter @fdbtrade/contracts run lint` (clean)
- `pnpm --filter @fdbtrade/contracts run test` — 24 files / 341 tests
  green, including 4 new P12 suites (analytics-outcome, analytics-
  calibration, analytics-mae-mfe, analytics-attribution) covering happy
  path, malformed/missing input, boundary/empty cases, fail-closed
  lineage/currency checks and idempotency (shuffled input => identical
  reports).
- Acceptance: metrics filterable by strategy/symbol/timeframe/regime;
  calibration distinguishes insufficient vs stable samples; entry/exit
  quality diagnosable from stored MAE/MFE; attribution totals reconcile to
  aggregate PnL within the recorded tolerance on every dimension.
