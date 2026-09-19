/**
 * Portfolio heat, currency exposure and correlation controls (P11-03,
 * ADR-0022).
 *
 * Frozen semantics:
 * - PORTFOLIO HEAT = the sum of planned stop risks of all OPEN positions
 *   plus the candidate entry, as a fraction of current equity. Each open
 *   position's risk is attributed from its OWN protective stop
 *   (|avgPrice - stopLoss| x quantity x quote->account rate); no caller
 *   supplied risk number is trusted.
 * - CURRENCY-FACTOR EXPOSURE (documented model `currency-leg-overlap-v1`):
 *   every position contributes two SIGNED currency legs (long EURUSD: +EUR
 *   / -USD; short: mirrored), each valued at |quantity x avgPrice x rate|
 *   in account ccy. NET exposure per currency = signed sum (directional
 *   concentration); GROSS exposure per currency = sum of |legs| (the
 *   correlated-group exposure: USD appears in all 7 majors, so EURUSD +
 *   GBPUSD longs stack on the same USD leg). No hidden correlations: the
 *   model id is frozen in the limits config and pinned by tests.
 * - REDUNDANCY: concurrent positions with the same instrument AND direction
 *   (and the same strategy+instrument+direction) are counted from the open
 *   snapshot; caps come from the versioned limits config.
 * - Exposure projections are PURE: the candidate is layered over the open
 *   snapshot without mutating it. Deterministic for deterministic inputs;
 *   all timestamps UTC (ADR-0004); no broker access (ADR-0003/0005).
 */
import type { RiskConversionMetadata, RiskOpenPosition } from "./contract";
import type { RiskLimitsConfig } from "./limits";
import { riskHash16, riskRound6 } from "./util";

export const RISK_PORTFOLIO_ID = "risk-portfolio";
export const RISK_PORTFOLIO_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Risk attribution per open position
// ---------------------------------------------------------------------------

/**
 * Planned stop risk of one open position, account ccy, from ITS OWN stop
 * (never a caller supplied risk number).
 */
export function positionRiskAmountAccount(position: RiskOpenPosition): number {
  const distance = riskRound6(Math.abs(position.avgPrice - position.stopLoss));
  return riskRound6(distance * position.quantityUnits * position.conversion.conversionRate);
}

export interface PortfolioHeat {
  /** Total planned stop risk of the OPEN portfolio, account ccy. */
  totalRiskAccount: number;
  /** Heat as a fraction of current equity (>= 0). */
  fraction: number;
  /** Per-position attribution (audit trail). */
  positions: Array<{ positionId: string; riskAmountAccount: number; fraction: number }>;
}

/** Portfolio heat of the OPEN positions, fraction of `equity`. */
export function computePortfolioHeat(openPositions: readonly RiskOpenPosition[], equity: number): PortfolioHeat {
  if (!Number.isFinite(equity) || equity <= 0) {
    throw new RangeError(`equity must be finite and > 0: ${equity}`);
  }
  const positions = openPositions.map((p) => {
    const risk = positionRiskAmountAccount(p);
    return { positionId: p.positionId, riskAmountAccount: risk, fraction: riskRound6(risk / equity) };
  });
  const totalRiskAccount = riskRound6(positions.reduce((acc, p) => acc + p.riskAmountAccount, 0));
  return {
    totalRiskAccount,
    fraction: riskRound6(totalRiskAccount / equity),
    positions,
  };
}

/** Aggregate open risk + candidate risk, fraction of equity (heat check input). */
export function projectedHeatFraction(
  openPositions: readonly RiskOpenPosition[],
  candidateRiskAmountAccount: number,
  equity: number,
): number {
  if (!Number.isFinite(candidateRiskAmountAccount) || candidateRiskAmountAccount < 0) {
    throw new RangeError(
      `candidateRiskAmountAccount must be finite and >= 0: ${candidateRiskAmountAccount}`,
    );
  }
  const open = computePortfolioHeat(openPositions, equity);
  return riskRound6((open.totalRiskAccount + candidateRiskAmountAccount) / equity);
}

// ---------------------------------------------------------------------------
// Currency legs / exposure projection (model: currency-leg-overlap-v1)
// ---------------------------------------------------------------------------

/** Signed exposure contribution of one leg, account ccy. */
interface CurrencyLeg {
  currency: string;
  signedExposure: number;
}

function baseCurrencyOf(instrument: string): string {
  return instrument.slice(0, 3);
}

function quoteCurrencyOf(instrument: string): string {
  return instrument.slice(3, 6);
}

/**
 * Signed currency legs of one position (model `currency-leg-overlap-v1`).
 * Long: +base / -quote; short: mirrored. Leg magnitude = quantity x
 * avgPrice x rate, account ccy. Only standard 6-char FX ids are projected;
 * other instruments contribute no legs (conservative for metals — their
 * currency overlap is not modelled in v1 and stays uncovered).
 */
export function currencyLegsOfPosition(position: {
  instrument: string;
  direction: "long" | "short";
  quantityUnits: number;
  avgPrice: number;
  conversion: RiskConversionMetadata;
}): CurrencyLeg[] {
  const magnitude = riskRound6(
    position.quantityUnits * position.avgPrice * position.conversion.conversionRate,
  );
  const base = baseCurrencyOf(position.instrument);
  const quote = quoteCurrencyOf(position.instrument);
  const valid = /^[A-Z]{3}$/.test(base) && /^[A-Z]{3}$/.test(quote) && position.instrument.length === 6;
  if (!valid || base === quote) return [];
  const sign = position.direction === "long" ? 1 : -1;
  return [
    { currency: base, signedExposure: riskRound6(sign * magnitude) },
    { currency: quote, signedExposure: riskRound6(-sign * magnitude) },
  ];
}

export interface CurrencyExposure {
  currency: string;
  /** Signed sum of legs, account ccy. */
  net: number;
  /** Sum of |legs|, account ccy (correlated-group exposure). */
  gross: number;
  /** |net| / equity. */
  netFraction: number;
  /** gross / equity. */
  grossFraction: number;
}

export interface ExposureProjection {
  exposures: CurrencyExposure[];
  /** Sorted currencies covered by the model (deterministic order). */
  currencies: string[];
}

/** Exposure projection of the OPEN positions only. */
export function projectOpenExposures(
  openPositions: readonly RiskOpenPosition[],
  equity: number,
): ExposureProjection {
  return projectExposures(openPositions, null, equity);
}

/**
 * Exposure projection layering the CANDIDATE entry over the OPEN snapshot
 * (pure; the snapshot is not mutated). Deterministic output order.
 */
export function projectExposures(
  openPositions: readonly RiskOpenPosition[],
  candidate: {
    instrument: string;
    direction: "long" | "short";
    quantityUnits: number;
    avgPrice: number;
    conversion: RiskConversionMetadata;
  } | null,
  equity: number,
): ExposureProjection {
  if (!Number.isFinite(equity) || equity <= 0) {
    throw new RangeError(`equity must be finite and > 0: ${equity}`);
  }
  const net = new Map<string, number>();
  const gross = new Map<string, number>();
  const add = (legs: CurrencyLeg[]): void => {
    for (const leg of legs) {
      net.set(leg.currency, riskRound6((net.get(leg.currency) ?? 0) + leg.signedExposure));
      gross.set(leg.currency, riskRound6((gross.get(leg.currency) ?? 0) + Math.abs(leg.signedExposure)));
    }
  };
  for (const p of openPositions) add(currencyLegsOfPosition(p));
  if (candidate !== null) add(currencyLegsOfPosition(candidate));
  const currencies = [...net.keys()].sort();
  const exposures = currencies.map((currency) => {
    const n = net.get(currency) ?? 0;
    const g = gross.get(currency) ?? 0;
    return {
      currency,
      net: n,
      gross: g,
      netFraction: riskRound6(Math.abs(n) / equity),
      grossFraction: riskRound6(g / equity),
    };
  });
  return { exposures, currencies };
}

// ---------------------------------------------------------------------------
// Redundancy counts
// ---------------------------------------------------------------------------

/**
 * Redundancy penalty inputs for the candidate entry: concurrent OPEN
 * positions with the same instrument+direction and with the same
 * strategy+instrument+direction. The candidate COUNTS itself (a count >=
 * its cap denies the entry).
 */
export function redundancyCounts(
  openPositions: readonly RiskOpenPosition[],
  candidate: { instrument: string; direction: "long" | "short"; strategyId: string },
): { perInstrumentDirection: number; perStrategyInstrument: number } {
  let perInstrumentDirection = 0;
  let perStrategyInstrument = 0;
  for (const p of openPositions) {
    if (p.instrument === candidate.instrument && p.direction === candidate.direction) {
      perInstrumentDirection += 1;
      if (p.strategyId === candidate.strategyId) perStrategyInstrument += 1;
    }
  }
  return { perInstrumentDirection, perStrategyInstrument };
}

/**
 * Redundancy denial: returns the reason code when the candidate would
 * breach a redundancy cap, else null. Caps come from the versioned limits
 * config (`maxPerInstrumentDirection`, `maxPerStrategyInstrument`).
 */
export function redundancyDenial(
  openPositions: readonly RiskOpenPosition[],
  candidate: { instrument: string; direction: "long" | "short"; strategyId: string },
  config: RiskLimitsConfig,
): "risk_redundant_position" | "risk_redundant_strategy" | null {
  const counts = redundancyCounts(openPositions, candidate);
  if (counts.perInstrumentDirection >= config.maxPerInstrumentDirection) {
    return "risk_redundant_position";
  }
  if (counts.perStrategyInstrument >= config.maxPerStrategyInstrument) {
    return "risk_redundant_strategy";
  }
  return null;
}
