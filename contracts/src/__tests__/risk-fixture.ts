/**
 * Shared deterministic risk fixtures (P11 tests).
 *
 * Deterministic only: fixed UTC instants, fixture provider/conversion
 * metadata (rates are data with provenance, never literals in production
 * paths); no randomness, no wall clock, no secrets.
 */
import {
  DEFAULT_RISK_LIMITS,
  type RiskCheckRequest,
  type RiskLimitsConfig,
  type RiskOpenPosition,
} from "@/index";

const T_CHECK = "2026-09-08T10:00:00.000Z";

/** Shared limits configuration for the P11 suites. */
export const RISK_CONFIG: RiskLimitsConfig = { ...DEFAULT_RISK_LIMITS };

/** Conversion metadata: quote -> account USD at a fixed fixture instant. */
export function usdConversion(rateAtUtc = "2026-09-08T09:00:00.000Z") {
  return {
    quoteCurrency: "USD",
    accountCurrency: "USD",
    conversionRate: 1,
    rateAtUtc,
    rateSource: "fixture",
  };
}

/** Deterministic EURUSD long entry request (stop 30 pips below entry). */
export function baseRequest(overrides: Partial<RiskCheckRequest> = {}): RiskCheckRequest {
  return {
    checkedAtUtc: T_CHECK,
    intentId: "btord_sig_p11fixture_EURUSD_1h_long",
    signalId: "sig_p11fixture_EURUSD_1h_2026-09-08T10:00:00.000Z_long",
    strategyId: "trend-mtf-pullback",
    strategyVersion: "1.0.0",
    configVersion: "1.0.0",
    snapshotHash: "a".repeat(64),
    instrument: "EURUSD",
    timeframe: "1h",
    direction: "long",
    entryType: "market",
    entryPrice: null,
    referencePrice: 1.1085,
    stopLoss: 1.1055,
    takeProfit: 1.1135,
    eventTimeUtc: "2026-09-08T10:00:00.000Z",
    expiresAtUtc: "2026-09-08T14:00:00.000Z",
    requestedQuantityUnits: 10000,
    account: {
      accountCurrency: "USD",
      equity: 100000,
      dayStartUtc: "2026-09-08T00:00:00.000Z",
      equityAtDayStart: 100000,
      weekStartUtc: "2026-09-07T00:00:00.000Z",
      weekPeakEquity: 100000,
    },
    openPositions: [],
    market: {
      instrument: "EURUSD",
      providerId: "fixture",
      providerHealth: "healthy",
      barTimeframe: "1h",
      lastClosedBarOpenUtc: "2026-09-08T09:00:00.000Z",
      observedSpreadPips: 1,
      estimatedSlippagePips: 0.5,
      conversion: usdConversion(),
    },
    riskState: "green",
    activeOverrideId: null,
    ...overrides,
  };
}

/**
 * One open EURUSD long carrying `risk` of planned stop risk in account ccy
 * (stop distance 0.0030, rate 1: quantity = risk / 0.0030).
 */
export function openLong(
  positionId: string,
  risk: number,
  strategyId = "trend-mtf-pullback",
): RiskOpenPosition {
  return {
    positionId,
    instrument: "EURUSD",
    direction: "long",
    quantityUnits: Number((risk / 0.003).toFixed(6)),
    avgPrice: 1.1085,
    stopLoss: 1.1055,
    openedAtUtc: "2026-09-08T08:00:00.000Z",
    strategyId,
    conversion: usdConversion("2026-09-08T08:00:00.000Z"),
  };
}
