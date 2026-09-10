/**
 * Baseline strategy registry (P07-01).
 *
 * One place the private pipeline (and later phases) lists the P5 baseline
 * strategies with their lineage (id + logic semver + config semver). Pure
 * data — constructing a strategy never touches an execution layer, clock
 * or random source (ADR-0003/0005). The ensemble weight table (P06-02) is
 * referenced by strategy id; this registry is the id source of truth for
 * the UI layer.
 */
import {
  type BreakoutStrategy,
  createBreakoutStrategy,
} from "@/strategy/breakout";
import {
  createMeanReversionStrategy,
  type MeanReversionStrategy,
} from "@/strategy/meanReversion";
import { createMomentumStrategy, type MomentumStrategy } from "@/strategy/momentum";
import {
  createTrendPullbackStrategy,
  type TrendPullbackStrategy,
} from "@/strategy/trendPullback";

// Strategy ids re-exported for weight tables / registries (single source).
export {
  BREAKOUT_STRATEGY_ID,
  BREAKOUT_STRATEGY_VERSION,
} from "@/strategy/breakout";
export {
  MEAN_REVERSION_STRATEGY_ID,
  MEAN_REVERSION_STRATEGY_VERSION,
} from "@/strategy/meanReversion";
export {
  MOMENTUM_STRATEGY_ID,
  MOMENTUM_STRATEGY_VERSION,
} from "@/strategy/momentum";
export {
  TREND_STRATEGY_ID,
  TREND_STRATEGY_VERSION,
} from "@/strategy/trendPullback";


export type BaselineStrategy =
  | MomentumStrategy
  | TrendPullbackStrategy
  | BreakoutStrategy
  | MeanReversionStrategy;

/** All P5 baseline strategies, constructed with their default configs. */
export const BASELINE_STRATEGIES: readonly BaselineStrategy[] = Object.freeze([
  createMomentumStrategy(),
  createTrendPullbackStrategy(),
  createBreakoutStrategy(),
  createMeanReversionStrategy(),
]);

/** Strategy lineage row (id + versions) for display/audit surfaces. */
export interface StrategyLineage {
  strategyId: string;
  strategyVersion: string;
  configVersion: string;
  timeframe: string;
  description: string;
}

/** Lineage of every baseline strategy (deterministic, order-stable). */
export const BASELINE_STRATEGY_LINEAGE: readonly StrategyLineage[] = Object.freeze(
  BASELINE_STRATEGIES.map((s) => ({
    strategyId: s.id,
    strategyVersion: s.version,
    configVersion: s.configVersion,
    timeframe: s.timeframe,
    description: s.description,
  })),
);
