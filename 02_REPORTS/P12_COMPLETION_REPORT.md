# Completion Report

Prompt ID: P12_Analytics (P12-01 through P12-04, executed in required order)
Phase: P12 Analytics
Date/time UTC: 2026-09-11T21:40:00Z
Branch/commit: main / c001db9 + P10/P11/P12 working tree (uncommitted)

## What changed

The P12 Analytics phase is complete: trade outcome analytics (P12-01),
calibration analytics (P12-02), MAE/MFE analytics (P12-03) and
attribution/regime analytics (P12-04). All analytics live in
`contracts/src/analytics/` as pure, typed, zod-validated TS contracts +
deterministic computations (ADR-0023), consuming the frozen P08 backtest
and P10 paper position contracts with full lineage verification. The phase
gate "Expectancy + calibration + MAE/MFE + attribution" is satisfied.

### P12-01 — Trade outcome analytics (`outcome.ts`)
- `AnalyticsTradeRecord`: canonical closed-trade input (lineage: strategy/
  version/config, instrument, timeframe, direction, regime, confidence,
  entry/exit UTC, exit reason, realized PnL + currency, planned risk,
  COMPUTED `rMultiple`, MAE/MFE pips, optional `portfolioFactor` tag).
  `rMultiple` is pinned by a schema refine (`round6(realizedPnl /
  plannedRisk)`) — inconsistent caller-supplied R cannot cross the
  boundary; null-risk records degrade to the recorded subsample, never 0.
- Builders `tradeRecordFromBacktest(position, intent)` and
  `tradeRecordFromPaper(order, position, exitReason, ...)`: lineage-checked
  (intentId/instrument; paper conversion from the position's own recorded
  metadata — never a hard-coded rate), fail closed on open positions.
- `computeOutcomeReport`: expectancy (mean PnL), average R (recorded-risk
  subsample), win/loss/scratch counts, win rate, profit factor, longest
  win/loss streaks, 8-bin frozen R histogram, drawdown episodes on the
  cumulative closed-trade PnL curve (peak/trough/recovery timestamp, trades
  to recover, recoveryTimeMs; trailing below-peak stays unrecovered).
- `AnalyticsTradeFilter` (strategyIds, instruments, timeframes,
  regimeStates incl. explicit null, directions; inclusive, AND-combined,
  absent = pass) shared by ALL P12 reports and echoed in every report.

### P12-02 — Calibration analytics (`calibration.ts`)
- `CalibrationObservation` (forecast probability + binary outcome, lineage
  + model id); `calibrationObservationFromTrade` measures the record's
  `confidence` against its realized outcome — never equates confidence
  with win probability (non-goal pinned).
- `computeCalibrationReport`: Brier = mean (p-y)^2; log-loss = mean
  cross-entropy clamped to [epsilon, 1-epsilon] (epsilon 1e-12, recorded;
  p=0/1 stay finite); frozen reliability-bin edges [0,.2,.4,.6,.8,1];
  expected-vs-realized rates + gap; `sampleStatus` = `insufficient` below
  `minBinSample` (default 10) / `stable` at/above — per bin AND overall
  (acceptance criterion machine-readable).

### P12-03 — MAE/MFE analytics (`maeMfe.ts`)
- `computeExcursionSummary`: groups by strategy | instrument | regime |
  confidence bucket (frozen deciles `c00..c09` + `unknown` for null
  confidence); per group: mean/max MAE/MFE pips, mean R, win rate,
  `meanMfeEfficiency` (realized R / MFE-in-R; only when risk recorded).
- Trades with both excursions 0 (paper path without caller-supplied data)
  are `excursionMissingCount` — excluded from averages, never averaged as
  zeros. Pure projection — no strategy-rule writes (non-goal pinned by
  test).

### P12-04 — Attribution and regime analytics (`attribution.ts`)
- `computeAttributionReport`: EXCLUSIVE per-dimension attribution (no
  double-counting; each trade lands in exactly one group per dimension)
  across the frozen set: strategy, strategyVersion (`strategy@version`),
  regime (null -> `unattributed`), session (frozen UTC-hour convention:
  asia 00-07, london 07-12, overlap 12-16, newyork 16-21, offhours 21-24 —
  analytics label, NOT provider session metadata), direction, instrument
  (symbol), portfolioFactor (recorded tag, never invented).
- Every slice embeds reconciliation: `attributedPnl` vs aggregate
  `totalPnl` within `tolerance` (default 1e-6, the money-storage scale),
  with `reconciliationGap` + `reconciles` recorded per slice and overall
  (acceptance criterion).

## Files changed

Added:
- `contracts/src/analytics/util.ts` — round6 + epsilon helpers.
- `contracts/src/analytics/outcome.ts` — records, builders, filter,
  outcome metrics, drawdown episodes.
- `contracts/src/analytics/calibration.ts` — observations, Brier/log-loss,
  reliability bins, sample status.
- `contracts/src/analytics/maeMfe.ts` — confidence buckets, excursion
  groups/summary.
- `contracts/src/analytics/attribution.ts` — session labels, dimensions,
  attribution slices/report with reconciliation.
- `contracts/src/__tests__/analytics-fixture.ts` — deterministic backtest
  position/intent fixtures.
- `contracts/src/__tests__/analytics-outcome.test.ts` (15 tests).
- `contracts/src/__tests__/analytics-calibration.test.ts` (12 tests).
- `contracts/src/__tests__/analytics-mae-mfe.test.ts` (25 tests).
- `contracts/src/__tests__/analytics-attribution.test.ts` (24 tests).
- `docs/adr/ADR-0023-analytics-layer.md`.
- `02_REPORTS/P12_COMPLETION_REPORT.md` (this report).

Modified:
- `contracts/src/index.ts` — analytics barrel exports.
- `docs/adr/README.md` — ADR-0023 index row (required registry sync).
- `tests/test_ci_contracts.py` — KNOWN_ADRS + ADR-0023 (required registry
  sync; CI contract tests re-run green).

## Tests executed

- `pnpm --filter @fdbtrade/contracts run typecheck` — 0 errors.
- `pnpm --filter @fdbtrade/contracts run lint` — clean (pre-existing
  react-detect warning only).
- `pnpm --filter @fdbtrade/contracts run test` — 24 files / 341 tests
  green (91 new P12 tests: outcome 15, calibration 27, mae-mfe 25,
  attribution 24).
- `python3 -m unittest tests.test_ci_contracts` — 18 tests OK (ADR
  registry sync verified).
- `make check` (lint + typecheck + test + build): pnpm workspace lint/
  typecheck/test/build all clean (contracts 341, backend 61, frontend 9
  files green); Python 475/476 — the single failure is the PRE-EXISTING
  port-3000 blocker documented in the P10/P11 reports (unrelated process
  pid 104824 holding 127.0.0.1:3000; `make start` cannot bind). NOT
  assumed passed; see blockers.

Coverage per prompt requirements: valid input / expected output (all four
suites), malformed/missing input (schema refusals: missing tradeId, exit
before entry, inconsistent R, mixed currency, mixed model id, bad
tolerance/epsilon/minBinSample), boundary/empty (zero trades -> all-null
metrics + valid schema; empty bins keep edges; unrecovered trailing
drawdown; never-falling curve -> no episodes), idempotency (shuffled input
order -> byte-identical reports in all four suites), non-goal guards
(no strategy mutation in MAE/MFE; confidence never treated as win
probability). No new production bug discovered during implementation, so
no additional regression fixture beyond the pinned fail-closed cases.

## Acceptance criteria

- [x] P12-01: metrics computable (expectancy, average R, win/loss
  distribution, drawdown + recovery) AND filterable by strategy, symbol,
  timeframe and regime (filter test pins all four dimensions incl. null
  regime).
- [x] P12-02: calibration view distinguishes insufficient sample sizes
  from stable estimates (per-bin + overall `sampleStatus`; thin vs stable
  evidence pinned by test).
- [x] P12-03: entry/exit quality diagnosable from historical outcomes
  (MAE/MFE by strategy/instrument/regime/confidence bucket; MFE capture
  efficiency; missing excursion data counted, never averaged).
- [x] P12-04: attribution totals reconcile to aggregate PnL within the
  defined tolerance (per-slice reconciliationGap + reconciles flags;
  exclusive attribution pinned — no double-counting).
- [x] Relevant tests pass from a clean environment or the blocker is
  documented (contracts 341/341 green; Python 475/476 with the pre-existing
  port-3000 blocker documented — NOT assumed passed).
- [x] Lint/typecheck/build clean for affected packages (contracts
  typecheck 0 errors, lint clean; full workspace via make check).
- [x] No unrelated files modified without justification (ADR index + CI
  ADR registry are the required synchronization for ADR-0023).
- [x] Completion report written.
- [x] Trading safety: analytics is a pure downstream consumer; no broker
  access anywhere in `contracts/src/analytics/`; live execution remains
  OFF (ADR-0005).

## Known limitations / blockers

- Port 3000 occupied by unrelated process (pid 104824), so the
  `make start`-based Python acceptance (`test_skeleton_contracts`) cannot
  run to green. Pre-existing blocker (documented in P10 and P11 reports);
  to verify: stop that process and rerun
  `python3 -m unittest tests.test_skeleton_contracts`.
- Analytics is a pure contracts layer: no API endpoints, DB tables or
  dashboard UI in this phase (P13 admin/observability owns surfaces);
  builders are ready for wiring without schema churn.
- Paper-path excursion/exit-reason inputs must be caller-supplied (the
  P10 ledger tracks neither) — explicit contract, not fabricated data.
- MAE-efficiency (stop-distance fraction) was cut: stop distance in pips
  is not on the trade record; adding it requires a deliberate contract
  change in a later prompt (documented in ADR-0023).
- Session attribution is hour-based UTC convention; DST-accurate session
  semantics require provider metadata joins (out of scope, documented).
- No Python mirror required by P12 scope (same as P11 risk layer).

## Follow-up required before next prompt

- None for P12. Next prompt per RUN_ORDER: P13 (Admin/Observability) —
  admin, observability, audit, strategy/model registry.

## Risk notes

- Trading safety: the analytics layer never calls a broker, strategy
  runtime or provider; it only projects recorded outcomes. The hard
  boundary strategy -> signal -> risk -> execution is untouched; live
  execution stays OFF (ADR-0005).
- Quant integrity: `rMultiple` is computed and schema-pinned (no
  caller-invented R); trades are time-ordered before cumulative math (no
  order-dependent metrics); drawdown is on the closed-trade curve with
  recovery defined as first return to the prior peak (explicit, testable);
  calibration measures the empirical confidence/outcome relationship and
  never claims confidence equals win probability; thin samples are
  machine-readably `insufficient`; log-loss clamping is recorded in every
  report (no hidden convention); attribution is exclusive with embedded
  reconciliation so no dimension can silently double-count PnL; missing
  inputs degrade to nulls or recorded subsamples, never to 0.
- Security: no secrets, credentials or provider endpoints in any analytics
  schema, fixture, report or log payload; conversion metadata carries
  `rateSource` provenance (data, not literals).
