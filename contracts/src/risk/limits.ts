/**
 * Risk hard limits and position sizing (P11-02, ADR-0022).
 *
 * Frozen semantics:
 * - Hard limits are authoritative: they are data-driven (`RiskLimitsConfig`,
 *   versioned), fail closed on malformed input, and can NEVER be bypassed by
 *   strategy, AI/LLM or operator overrides (overrides change the risk STATE,
 *   never the limit checks — P11-04).
 * - Sizing is deterministic: the risk engine sizes each entry from the
 *   per-trade risk budget (equity x risk-fraction) and the stop distance,
 *   converting quote-currency stop risk into account currency with
 *   provenance-carrying conversion metadata (rates are DATA, never literals).
 *   The FINAL size is always min(requested, risk-sized) — the strategy
 *   proposal can only be reduced, never inflated.
 * - Initial 0.25-0.50% per-trade risk is the frozen blueprint PLACEHOLDER —
 *   configuration, not a promise.
 * - Boundary convention: caps compare with strict `>` (an order exactly AT a
 *   cap is allowed), loss stops compare with `>=` (reaching the stop is a
 *   breach). Both conventions are pinned by tests.
 * - Stale-data gate: freshness is measured from the CLOSE of the last
 *   closed bar (open time + timeframe); data older than `maxDataAgeMs` at
 *   check time fails closed. Data whose "closed" bar closes in the future
 *   relative to the check time is a look-ahead shape and fails closed too.
 * - All timestamps are UTC (ADR-0004); no wall clock, no randomness, no
 *   broker access (ADR-0003/0005).
 */
import { z } from "zod";

import { TIMEFRAME_MS, type Timeframe } from "../marketdata/time";

import type { RiskAccountSnapshot, RiskConversionMetadata } from "./contract";
import { stateEntryRiskFactor, type RiskState } from "./states";
import { riskRound6 } from "./util";

export const RISK_LIMITS_ID = "risk-limits";
export const RISK_LIMITS_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Versioned limits configuration
// ---------------------------------------------------------------------------

export const riskLimitsConfigSchema = z
  .object({
    riskConfigVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    /** Max planned risk per trade, fraction of equity (blueprint placeholder 0.25-0.50%). */
    maxRiskPerTradeFraction: z.number().finite().gt(0).lte(0.05),
    /** Max aggregate open risk (portfolio heat), fraction of equity. */
    maxPortfolioHeatFraction: z.number().finite().gt(0).lte(0.1),
    /** Max daily loss stop, fraction of day-start equity. */
    maxDailyLossFraction: z.number().finite().gt(0).lte(0.1),
    /** Max weekly drawdown, fraction of week peak equity. */
    maxWeeklyDrawdownFraction: z.number().finite().gt(0).lte(0.2),
    /** Max concurrent open positions (hard count). */
    maxOpenPositions: z.number().int().min(1).max(100),
    /** Max observed spread, pips. */
    maxSpreadPips: z.number().finite().positive(),
    /** Max estimated slippage, pips. */
    maxSlippagePips: z.number().finite().positive(),
    /** Max age of the last closed bar (from its close), milliseconds. */
    maxDataAgeMs: z.number().int().positive().max(7 * 24 * 60 * 60 * 1000),
    /** Max concurrent positions with the SAME instrument AND direction. */
    maxPerInstrumentDirection: z.number().int().min(1).max(20),
    /** Max concurrent positions with the SAME strategy+instrument+direction. */
    maxPerStrategyInstrument: z.number().int().min(1).max(20),
    /** Max NET exposure per currency, fraction of equity (leverage-aware). */
    maxCurrencyExposureFraction: z.number().finite().gt(0).lte(20),
    /** Max GROSS (correlated-group) exposure per currency, fraction of equity. */
    maxCorrelatedGroupExposureFraction: z.number().finite().gt(0).lte(20),
    /** YELLOW-state per-trade risk multiplier, in (0,1]. */
    yellowRiskFactor: z.number().finite().gt(0).lte(1),
    /** Correlation model id — no hidden correlations (documented model only). */
    correlationModel: z.literal("currency-leg-overlap-v1"),
  })
  .strict();

export type RiskLimitsConfig = z.infer<typeof riskLimitsConfigSchema>;

/**
 * Frozen defaults matching the blueprint placeholders (0.50% per trade,
 * 3% heat, 2% daily stop, 5% weekly drawdown). Configuration, not a promise.
 */
export const DEFAULT_RISK_LIMITS: RiskLimitsConfig = Object.freeze({
  riskConfigVersion: "1.0.0",
  maxRiskPerTradeFraction: 0.005,
  maxPortfolioHeatFraction: 0.03,
  maxDailyLossFraction: 0.02,
  maxWeeklyDrawdownFraction: 0.05,
  maxOpenPositions: 5,
  maxSpreadPips: 2,
  maxSlippagePips: 1,
  maxDataAgeMs: 2 * 60 * 60 * 1000,
  maxPerInstrumentDirection: 1,
  maxPerStrategyInstrument: 1,
  maxCurrencyExposureFraction: 5,
  maxCorrelatedGroupExposureFraction: 10,
  yellowRiskFactor: 0.5,
  correlationModel: "currency-leg-overlap-v1",
});

/** Defensive config guard: fail closed on malformed limits. */
export function parseRiskLimitsConfig(config: RiskLimitsConfig): RiskLimitsConfig {
  return riskLimitsConfigSchema.parse(config);
}

// ---------------------------------------------------------------------------
// Loss/stop math (fractions of equity; deterministic)
// ---------------------------------------------------------------------------

/** Daily loss fraction vs day-start equity (>= 0; reaching the stop = breach). */
export function computeDailyLossFraction(account: RiskAccountSnapshot): number {
  if (!(account.equityAtDayStart > 0)) {
    throw new RangeError("equityAtDayStart must be positive");
  }
  const loss = (account.equityAtDayStart - account.equity) / account.equityAtDayStart;
  return riskRound6(Math.max(loss, 0));
}

/** Weekly drawdown fraction vs week peak equity (>= 0). */
export function computeWeeklyDrawdownFraction(account: RiskAccountSnapshot): number {
  if (!(account.weekPeakEquity > 0)) {
    throw new RangeError("weekPeakEquity must be positive");
  }
  const dd = (account.weekPeakEquity - account.equity) / account.weekPeakEquity;
  return riskRound6(Math.max(dd, 0));
}

// ---------------------------------------------------------------------------
// Stale-data gate (freshness from the CLOSE of the last closed bar)
// ---------------------------------------------------------------------------

/** Bar close time (UTC epoch ms) of the last closed bar. */
export function lastClosedBarCloseMs(lastClosedBarOpenUtc: string, barTimeframe: Timeframe): number {
  return Date.parse(lastClosedBarOpenUtc) + TIMEFRAME_MS[barTimeframe];
}

/**
 * Stale-data gate. FAILS CLOSED both ways:
 * - the last closed bar CLOSES in the future relative to `checkedAtUtc`
 *   (a look-ahead shape — invalid), or
 * - its close is older than `maxDataAgeMs` (stale).
 * Returns the reason code when stale, else null.
 */
export function staleDataReason(
  checkedAtUtc: string,
  lastClosedBarOpenUtc: string,
  barTimeframe: Timeframe,
  maxDataAgeMs: number,
): "risk_data_stale" | null {
  if (!Number.isFinite(maxDataAgeMs) || maxDataAgeMs <= 0) {
    throw new RangeError(`maxDataAgeMs must be positive: ${maxDataAgeMs}`);
  }
  const checkedMs = Date.parse(checkedAtUtc);
  const closeMs = lastClosedBarCloseMs(lastClosedBarOpenUtc, barTimeframe);
  if (checkedMs < closeMs) return "risk_data_stale";
  if (checkedMs - closeMs > maxDataAgeMs) return "risk_data_stale";
  return null;
}

// ---------------------------------------------------------------------------
// Deterministic risk-based sizing
// ---------------------------------------------------------------------------

export interface SizingInput {
  equity: number;
  /** Per-trade risk budget as a fraction of equity (already state-scaled). */
  riskFraction: number;
  /** Entry level the stop distance is measured from (resting or reference). */
  entryPrice: number;
  stopLossPrice: number;
  /** quote -> account conversion for the entry instrument (sizing). */
  conversion: RiskConversionMetadata;
}

export interface SizingResult {
  sizedQuantityUnits: number;
  /** Stop distance in price units (>= 0). */
  stopDistancePrice: number;
  /** Account-ccy risk per ONE base unit (stopDistance x conversionRate). */
  perUnitRiskAccount: number;
  /** Account-ccy risk of the sized quantity. */
  riskAmountAccount: number;
  /** Realized per-trade risk fraction (<= riskFraction by construction). */
  riskFractionUsed: number;
}

/**
 * Size one entry so its planned stop risk equals the risk budget:
 * quantity = (equity x riskFraction) / (stopDistancePrice x quote->account
 * rate). Round6 storage convention. A non-positive result (stop wider than
 * the budget can carry, or equity too small) means the entry is infeasible.
 */
export function sizePositionByRisk(input: SizingInput): SizingResult {
  const { equity, riskFraction, entryPrice, stopLossPrice, conversion } = input;
  if (!Number.isFinite(equity) || equity <= 0) {
    throw new RangeError(`equity must be finite and > 0: ${equity}`);
  }
  if (!Number.isFinite(riskFraction) || riskFraction < 0) {
    throw new RangeError(`riskFraction must be finite and >= 0: ${riskFraction}`);
  }
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new RangeError(`entryPrice must be finite and > 0: ${entryPrice}`);
  }
  if (!Number.isFinite(stopLossPrice) || stopLossPrice <= 0) {
    throw new RangeError(`stopLossPrice must be finite and > 0: ${stopLossPrice}`);
  }
  if (!Number.isFinite(conversion.conversionRate) || conversion.conversionRate <= 0) {
    throw new RangeError(`conversionRate must be finite and > 0: ${conversion.conversionRate}`);
  }
  const stopDistancePrice = riskRound6(Math.abs(entryPrice - stopLossPrice));
  if (stopDistancePrice === 0) {
    // A zero stop distance cannot carry risk; the entry is infeasible.
    return {
      sizedQuantityUnits: 0,
      stopDistancePrice: 0,
      perUnitRiskAccount: 0,
      riskAmountAccount: 0,
      riskFractionUsed: 0,
    };
  }
  const perUnitRiskAccount = riskRound6(stopDistancePrice * conversion.conversionRate);
  const budget = riskRound6(equity * riskFraction);
  const sized = riskRound6(budget / perUnitRiskAccount);
  const riskAmountAccount = riskRound6(sized * perUnitRiskAccount);
  return {
    sizedQuantityUnits: Math.max(sized, 0),
    stopDistancePrice,
    perUnitRiskAccount,
    riskAmountAccount,
    riskFractionUsed: riskRound6(riskAmountAccount / equity),
  };
}

/** Final authorized size: min(strategy proposal, risk-sized cap). */
export function finalQuantityUnits(
  requestedQuantityUnits: number,
  sizedQuantityUnits: number,
): { quantityUnits: number; adjusted: boolean } {
  if (!Number.isFinite(requestedQuantityUnits) || requestedQuantityUnits <= 0) {
    throw new RangeError(`requestedQuantityUnits must be positive: ${requestedQuantityUnits}`);
  }
  if (!Number.isFinite(sizedQuantityUnits) || sizedQuantityUnits < 0) {
    throw new RangeError(`sizedQuantityUnits must be finite and >= 0: ${sizedQuantityUnits}`);
  }
  const quantity = riskRound6(Math.min(requestedQuantityUnits, sizedQuantityUnits));
  return { quantityUnits: Math.max(quantity, 0), adjusted: quantity < requestedQuantityUnits };
}

/**
 * The per-trade risk budget actually available in `state` (P11-04):
 * green = full budget, yellow = yellowRiskFactor x budget, orange/red/kill
 * = 0 (no new risk).
 */
export function availablePerTradeRiskFraction(state: RiskState, config: RiskLimitsConfig): number {
  const factor = stateEntryRiskFactor(state, config.yellowRiskFactor);
  return config.maxRiskPerTradeFraction * factor;
}
