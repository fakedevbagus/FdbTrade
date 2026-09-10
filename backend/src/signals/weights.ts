/**
 * Weight table for the private dashboard pipeline (P07-01).
 *
 * DOCUMENTED PLACEHOLDER — mirrors the P06-02 pattern: fixed, auditable
 * per-regime weights, versioned (`dashboardWeightsVersion`), NOT tuned (no
 * optimization before the P8/P9 validation gates — ADR-0016/0017/0018).
 * Baseline spread: trend-following strategies carry more mass in `trend`,
 * reversion strategies more mass in `range`; volatility strategies stay
 * eligible in the volatility states; `unknown` is EMPTY = fail closed (the
 * regime gate rejects, ADR-0016) — never an improvised weight.
 */
import type { EnsembleWeightTable } from "@fdbtrade/contracts";

import {
  BREAKOUT_STRATEGY_ID,
  MEAN_REVERSION_STRATEGY_ID,
  MOMENTUM_STRATEGY_ID,
  TREND_STRATEGY_ID,
} from "@/strategy/all";

export const DASHBOARD_WEIGHT_TABLE_VERSION = "1.0.0";

export const DASHBOARD_WEIGHT_TABLE: EnsembleWeightTable = {
  version: DASHBOARD_WEIGHT_TABLE_VERSION,
  weights: {
    trend: {
      [MOMENTUM_STRATEGY_ID]: 0.35,
      [TREND_STRATEGY_ID]: 0.4,
      [BREAKOUT_STRATEGY_ID]: 0.15,
      [MEAN_REVERSION_STRATEGY_ID]: 0.1,
    },
    range: {
      [MOMENTUM_STRATEGY_ID]: 0.15,
      [TREND_STRATEGY_ID]: 0.1,
      [BREAKOUT_STRATEGY_ID]: 0.35,
      [MEAN_REVERSION_STRATEGY_ID]: 0.4,
    },
    high_volatility: {
      [MOMENTUM_STRATEGY_ID]: 0.1,
      [TREND_STRATEGY_ID]: 0.1,
      [BREAKOUT_STRATEGY_ID]: 0.3,
      [MEAN_REVERSION_STRATEGY_ID]: 0.1,
    },
    low_volatility: {
      [MOMENTUM_STRATEGY_ID]: 0.1,
      [TREND_STRATEGY_ID]: 0.1,
      [BREAKOUT_STRATEGY_ID]: 0.3,
      [MEAN_REVERSION_STRATEGY_ID]: 0.2,
    },
    transition: {
      [MOMENTUM_STRATEGY_ID]: 0.1,
      [TREND_STRATEGY_ID]: 0.1,
      [BREAKOUT_STRATEGY_ID]: 0.1,
      [MEAN_REVERSION_STRATEGY_ID]: 0.1,
    },
    // Fail closed: no strategy is eligible in an unresolved regime.
    unknown: {},
  },
};

