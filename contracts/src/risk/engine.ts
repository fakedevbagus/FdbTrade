/**
 * Risk evaluation engine (P11-02/03/04 orchestration, ADR-0022).
 *
 * `evaluateRisk` is the ONE deterministic gate every paper/demo order intent
 * must pass through. It is a pure function of (request, limits config):
 * no wall clock, no randomness, no network, no broker access.
 *
 * Frozen check order (deterministic, short-circuiting groups; the first
 * failing group finalizes the decision):
 *   1. control plane  - kill switch, orange/red state, stale data,
 *                       provider outage/unknown health (fail closed),
 *   2. account limits - daily loss stop, weekly drawdown, max positions,
 *                       spread cap, slippage cap,
 *   3. portfolio      - sizing feasibility, portfolio heat, currency
 *                       exposure, correlated-group exposure, redundancy.
 *
 * Boundary conventions: caps compare with strict `>` (exactly at cap is
 * allowed); loss stops compare with `>=`; the candidate counts itself in
 * redundancy counts (`>=` cap denies). Malformed input FAILS CLOSED with a
 * `RiskEngineError`. The decision id is content-addressed: the same
 * request/config always produces the same decision (idempotent).
 */
import { riskHash16, riskRound6 } from "./util";

import {
  availablePerTradeRiskFraction,
  computeDailyLossFraction,
  computeWeeklyDrawdownFraction,
  finalQuantityUnits,
  parseRiskLimitsConfig,
  sizePositionByRisk,
  staleDataReason,
  type RiskLimitsConfig,
} from "./limits";
import {
  computePortfolioHeat,
  projectExposures,
  projectedHeatFraction,
  redundancyDenial,
  redundancyCounts,
} from "./portfolio";
import {
  riskCheckRequestSchema,
  riskDecisionSchema,
  riskDecisionIdFor,
  riskRequestDigestFor,
  RISK_ENGINE_ID,
  RISK_ENGINE_VERSION,
  serializeRiskDecisionContentCanonical,
  type RiskCheckRequest,
  type RiskDecision,
  type RiskRejectReason,
} from "./contract";

export const RISK_EVALUATOR_ID = "risk-evaluator";
export const RISK_EVALUATOR_VERSION = "1.0.0";

/** Fail-closed error for malformed requests/configs. */
export class RiskEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RiskEngineError";
  }
}

function buildDecision(
  request: RiskCheckRequest,
  config: RiskLimitsConfig,
  requestDigest: string,
  outcome: "approved" | "rejected",
  reasons: RiskRejectReason[],
  sizedQuantityUnits: number,
  sizeAdjusted: boolean,
  riskAmountAccount: number,
  utilization: { portfolioHeatRatio: number; dailyLossRatio: number; weeklyDrawdownRatio: number },
): RiskDecision {
  const equity = request.account.equity;
  const content: Omit<RiskDecision, "decisionId"> = {
    riskEngineId: RISK_ENGINE_ID,
    riskEngineVersion: RISK_ENGINE_VERSION,
    riskConfigVersion: config.riskConfigVersion,
    checkedAtUtc: request.checkedAtUtc,
    intentId: request.intentId,
    signalId: request.signalId,
    strategyId: request.strategyId,
    instrument: request.instrument,
    direction: request.direction,
    outcome,
    sizedQuantityUnits,
    requestedQuantityUnits: request.requestedQuantityUnits,
    sizeAdjusted,
    riskAmountAccount: riskRound6(riskAmountAccount),
    riskFractionUsed: riskRound6(riskAmountAccount / equity),
    reasons: [...reasons],
    riskState: request.riskState,
    utilization,
    requestDigest,
    activeOverrideId: request.activeOverrideId,
  };
  const decisionId = riskDecisionIdFor(serializeRiskDecisionContentCanonical(content));
  return riskDecisionSchema.parse({ ...content, decisionId });
}

/** Machine-readable rejection reasons; empty iff approved. */
function dedupeReasons(reasons: RiskRejectReason[]): RiskRejectReason[] {
  return [...new Set(reasons)];
}

/**
 * The one deterministic risk gate (P11-02/03/04). Pure; idempotent; fail
 * closed on malformed input. See the module header for the frozen check
 * order and boundary conventions.
 */
export function evaluateRisk(request: RiskCheckRequest, config: RiskLimitsConfig): RiskDecision {
  let limits: RiskLimitsConfig;
  let req: RiskCheckRequest;
  try {
    limits = parseRiskLimitsConfig(config);
    req = riskCheckRequestSchema.parse(request);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new RiskEngineError(`malformed risk check input (fail closed): ${detail}`);
  }

  const equity = req.account.equity;
  const dailyLoss = computeDailyLossFraction(req.account);
  const weeklyDD = computeWeeklyDrawdownFraction(req.account);
  const heatOpen = computePortfolioHeat(req.openPositions, equity);
  const utilization = {
    portfolioHeatRatio: riskRound6(heatOpen.fraction / limits.maxPortfolioHeatFraction),
    dailyLossRatio: riskRound6(dailyLoss / limits.maxDailyLossFraction),
    weeklyDrawdownRatio: riskRound6(weeklyDD / limits.maxWeeklyDrawdownFraction),
  };
  const requestDigest = riskRequestDigestFor(req);

  const reject = (reasons: RiskRejectReason[]): RiskDecision =>
    buildDecision(req, limits, requestDigest, "rejected", reasons, 0, false, 0, utilization);

  // --- group 1: control plane (kill switch / state / staleness / outage) ---
  const control: RiskRejectReason[] = [];
  if (req.riskState === "kill") control.push("risk_kill_engaged");
  else if (req.riskState === "orange") control.push("risk_state_orange");
  else if (req.riskState === "red") control.push("risk_state_red");
  const stale = staleDataReason(
    req.checkedAtUtc,
    req.market.lastClosedBarOpenUtc,
    req.market.barTimeframe,
    limits.maxDataAgeMs,
  );
  if (stale !== null) control.push(stale);
  if (req.market.providerHealth !== "healthy") control.push("risk_provider_unhealthy");
  if (control.length > 0) return reject(control);

  // --- group 2: account hard limits ---
  const account: RiskRejectReason[] = [];
  if (dailyLoss >= limits.maxDailyLossFraction) account.push("risk_daily_loss_stop");
  if (weeklyDD >= limits.maxWeeklyDrawdownFraction) account.push("risk_weekly_drawdown_stop");
  if (req.openPositions.length + 1 > limits.maxOpenPositions) {
    account.push("risk_max_open_positions");
  }
  if (req.market.observedSpreadPips > limits.maxSpreadPips) account.push("risk_spread_cap");
  if (req.market.estimatedSlippagePips > limits.maxSlippagePips) {
    account.push("risk_slippage_cap");
  }
  if (account.length > 0) return reject(account);

  // --- group 3: sizing + portfolio heat + correlation + redundancy ---
  const riskFraction = availablePerTradeRiskFraction(req.riskState, limits);
  const entry = req.entryPrice ?? req.referencePrice;
  const sizing = sizePositionByRisk({
    equity,
    riskFraction,
    entryPrice: entry,
    stopLossPrice: req.stopLoss,
    conversion: req.market.conversion,
  });
  const final = finalQuantityUnits(req.requestedQuantityUnits, sizing.sizedQuantityUnits);
  if (final.quantityUnits <= 0) return reject(["risk_sizing_unfeasible"]);

  const portfolio: RiskRejectReason[] = [];
  const candidateRisk = riskRound6(
    sizing.stopDistancePrice * final.quantityUnits * req.market.conversion.conversionRate,
  );
  const projectedHeat = projectedHeatFraction(req.openPositions, candidateRisk, equity);
  if (projectedHeat > limits.maxPortfolioHeatFraction) portfolio.push("risk_portfolio_heat_cap");

  const candidate = {
    instrument: req.instrument,
    direction: req.direction,
    quantityUnits: final.quantityUnits,
    avgPrice: entry,
    conversion: req.market.conversion,
  };
  const projected = projectExposures(req.openPositions, candidate, equity);
  for (const exposure of projected.exposures) {
    if (exposure.netFraction > limits.maxCurrencyExposureFraction) {
      portfolio.push("risk_currency_exposure_cap");
    }
    if (exposure.grossFraction > limits.maxCorrelatedGroupExposureFraction) {
      portfolio.push("risk_correlation_cap");
    }
  }
  const redundancy = redundancyDenial(
    req.openPositions,
    { instrument: req.instrument, direction: req.direction, strategyId: req.strategyId },
    limits,
  );
  if (redundancy !== null) portfolio.push(redundancy);
  if (portfolio.length > 0) return reject(dedupeReasons(portfolio));

  // --- approved: risk engine owns the FINAL size ---
  return buildDecision(
    req,
    limits,
    requestDigest,
    "approved",
    [],
    final.quantityUnits,
    final.adjusted,
    candidateRisk,
    utilization,
  );
}

/** Count inputs recorded with the decision (observability; P11-05). */
export function describeRiskCounts(req: RiskCheckRequest): {
  openPositions: number;
  redundancy: { perInstrumentDirection: number; perStrategyInstrument: number };
} {
  return {
    openPositions: req.openPositions.length,
    redundancy: redundancyCounts(req.openPositions, {
      instrument: req.instrument,
      direction: req.direction,
      strategyId: req.strategyId,
    }),
  };
}

