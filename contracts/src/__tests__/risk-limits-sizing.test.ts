/**
 * Risk hard limits and sizing tests (P11-02).
 *
 * Acceptance: impossible/over-limit orders are rejected with reason codes;
 * sizing is deterministic and the engine owns the FINAL size; boundary
 * conventions are pinned (caps strict `>`, loss stops `>=`, stale gate
 * inclusive of the exact age limit).
 */
import { describe, expect, it } from "vitest";

import {
  RiskEngineError,
  computeDailyLossFraction,
  computeWeeklyDrawdownFraction,
  evaluateRisk,
  finalQuantityUnits,
  lastClosedBarCloseMs,
  parseRiskLimitsConfig,
  sizePositionByRisk,
  staleDataReason,
} from "@/index";

import { baseRequest, openLong, RISK_CONFIG, usdConversion } from "./risk-fixture";

describe("risk-based sizing (P11-02)", () => {
  it("sizes to the per-trade budget: budget / (stop distance x rate)", () => {
    const sizing = sizePositionByRisk({
      equity: 100000,
      riskFraction: 0.005,
      entryPrice: 1.1085,
      stopLossPrice: 1.1055,
      conversion: usdConversion(),
    });
    expect(sizing.stopDistancePrice).toBe(0.003);
    expect(sizing.perUnitRiskAccount).toBe(0.003);
    expect(sizing.sizedQuantityUnits).toBe(166666.666667); // 500 / 0.003
    expect(sizing.riskAmountAccount).toBe(500);
    expect(sizing.riskFractionUsed).toBe(0.005);
  });

  it("reduces the strategy proposal to the risk-sized cap and flags the adjustment", () => {
    const decision = evaluateRisk(baseRequest({ requestedQuantityUnits: 200000 }), RISK_CONFIG);
    expect(decision.outcome).toBe("approved");
    expect(decision.sizeAdjusted).toBe(true);
    expect(decision.sizedQuantityUnits).toBe(166666.666667);
    expect(decision.sizedQuantityUnits).toBeLessThan(decision.requestedQuantityUnits);
  });

  it("never inflates a strategy proposal below the cap", () => {
    const decision = evaluateRisk(baseRequest({ requestedQuantityUnits: 1 }), RISK_CONFIG);
    expect(decision.sizedQuantityUnits).toBe(1);
    expect(decision.sizeAdjusted).toBe(false);
  });

  it("finalQuantityUnits takes min(requested, sized)", () => {
    expect(finalQuantityUnits(100, 50)).toEqual({ quantityUnits: 50, adjusted: true });
    expect(finalQuantityUnits(40, 50)).toEqual({ quantityUnits: 40, adjusted: false });
  });

  it("rejects an infeasible entry (budget rounds to zero) with a reason code", () => {
    // day-start/peak equity equal to current equity so ONLY sizing can trip
    const account = {
      ...baseRequest().account,
      equity: 1e-7,
      equityAtDayStart: 1e-7,
      weekPeakEquity: 1e-7,
    };
    const decision = evaluateRisk(baseRequest({ account }), RISK_CONFIG);
    expect(decision.outcome).toBe("rejected");
    expect(decision.reasons).toEqual(["risk_sizing_unfeasible"]);
    expect(decision.sizedQuantityUnits).toBe(0);
  });

  it("sizing guards fail closed on malformed money inputs", () => {
    const conv = usdConversion();
    expect(() =>
      sizePositionByRisk({
        equity: 0,
        riskFraction: 0.005,
        entryPrice: 1.1085,
        stopLossPrice: 1.1055,
        conversion: conv,
      }),
    ).toThrow(RangeError);
    expect(() =>
      sizePositionByRisk({
        equity: 100000,
        riskFraction: -1,
        entryPrice: 1.1085,
        stopLossPrice: 1.1055,
        conversion: conv,
      }),
    ).toThrow(RangeError);
  });
});

describe("loss stops and drawdown (P11-02)", () => {
  it("daily loss fraction is measured vs day-start equity", () => {
    const account = { ...baseRequest().account, equity: 98001 };
    expect(computeDailyLossFraction(account)).toBeCloseTo(0.01999, 5);
  });

  it("reaching the daily stop is a breach (>=) with a reason code", () => {
    const decision = evaluateRisk(
      baseRequest({ account: { ...baseRequest().account, equity: 98000 } }),
      RISK_CONFIG,
    );
    expect(decision.outcome).toBe("rejected");
    expect(decision.reasons).toEqual(["risk_daily_loss_stop"]);
  });

  it("exactly below the daily stop is still allowed", () => {
    const decision = evaluateRisk(
      baseRequest({ account: { ...baseRequest().account, equity: 98001 } }),
      RISK_CONFIG,
    );
    expect(decision.outcome).toBe("approved");
  });

  it("weekly drawdown is measured vs week peak equity; reaching the cap breaches", () => {
    // day-start equity matches current equity so ONLY the weekly stop trips
    const account = {
      ...baseRequest().account,
      equity: 95000,
      equityAtDayStart: 95000,
      weekPeakEquity: 100000,
    };
    expect(computeWeeklyDrawdownFraction(account)).toBe(0.05);
    const decision = evaluateRisk(baseRequest({ account }), RISK_CONFIG);
    expect(decision.reasons).toEqual(["risk_weekly_drawdown_stop"]);
  });
});

describe("stale-data gate (P11-02)", () => {
  it("bar close time is the last closed bar open + timeframe", () => {
    expect(lastClosedBarCloseMs("2026-09-08T09:00:00.000Z", "1h")).toBe(
      Date.parse("2026-09-08T10:00:00.000Z"),
    );
  });

  it("data exactly at the max age limit is still acceptable (inclusive boundary)", () => {
    // close 10:00 + 3_600_000ms = 11:00 -> checked at exactly 11:00
    expect(
      staleDataReason("2026-09-08T11:00:00.000Z", "2026-09-08T09:00:00.000Z", "1h", 3_600_000),
    ).toBeNull();
  });

  it("data one millisecond past the age limit is stale", () => {
    expect(
      staleDataReason("2026-09-08T11:00:00.001Z", "2026-09-08T09:00:00.000Z", "1h", 3_600_000),
    ).toBe("risk_data_stale");
  });

  it("data whose closed bar closes in the future is a look-ahead shape and fails closed", () => {
    expect(
      staleDataReason("2026-09-08T10:30:00.000Z", "2026-09-08T10:00:00.000Z", "1h", 3_600_000),
    ).toBe("risk_data_stale");
    const decision = evaluateRisk(
      baseRequest({
        market: { ...baseRequest().market, lastClosedBarOpenUtc: "2026-09-08T10:00:00.000Z" },
      }),
      RISK_CONFIG,
    );
    expect(decision.reasons).toEqual(["risk_data_stale"]);
  });

  it("stale data blocks the new intent with a reason code", () => {
    const decision = evaluateRisk(baseRequest({ checkedAtUtc: "2026-09-08T13:00:01.000Z" }), {
      ...RISK_CONFIG,
      maxDataAgeMs: 3_600_000,
    });
    expect(decision.outcome).toBe("rejected");
    expect(decision.reasons).toEqual(["risk_data_stale"]);
  });
});

describe("spread / slippage / position-count caps (P11-02)", () => {
  it("spread exactly at cap is allowed; past cap is rejected with a reason code", () => {
    const atCap = evaluateRisk(
      baseRequest({ market: { ...baseRequest().market, observedSpreadPips: 2 } }),
      RISK_CONFIG,
    );
    expect(atCap.outcome).toBe("approved");
    const pastCap = evaluateRisk(
      baseRequest({ market: { ...baseRequest().market, observedSpreadPips: 2.1 } }),
      RISK_CONFIG,
    );
    expect(pastCap.reasons).toEqual(["risk_spread_cap"]);
  });

  it("slippage past cap is rejected with a reason code", () => {
    const decision = evaluateRisk(
      baseRequest({ market: { ...baseRequest().market, estimatedSlippagePips: 1.01 } }),
      RISK_CONFIG,
    );
    expect(decision.reasons).toEqual(["risk_slippage_cap"]);
  });

  it("opening up to maxOpenPositions is allowed; past it is rejected", () => {
    // redundancy caps relaxed so ONLY the position count can trip
    const config = {
      ...RISK_CONFIG,
      maxPerInstrumentDirection: 10,
      maxPerStrategyInstrument: 10,
    };
    const four = baseRequest({
      openPositions: [
        openLong("pbpos_1", 100),
        openLong("pbpos_2", 100),
        openLong("pbpos_3", 100),
        openLong("pbpos_4", 100),
      ],
    });
    expect(evaluateRisk(four, config).outcome).toBe("approved"); // 4 + 1 = 5 = cap
    const five = baseRequest({
      openPositions: [...four.openPositions, openLong("pbpos_5", 100)],
    });
    const decision = evaluateRisk(five, config);
    expect(decision.reasons).toEqual(["risk_max_open_positions"]);
  });
});

describe("limits config guards (P11-02)", () => {
  it("accepts the frozen defaults with the documented correlation model", () => {
    expect(parseRiskLimitsConfig(RISK_CONFIG).maxRiskPerTradeFraction).toBe(0.005);
    expect(RISK_CONFIG.correlationModel).toBe("currency-leg-overlap-v1");
  });

  it("rejects out-of-range limits (fail closed on nonsense)", () => {
    expect(() =>
      parseRiskLimitsConfig({ ...RISK_CONFIG, maxRiskPerTradeFraction: 0.5 }),
    ).toThrow();
    expect(() => parseRiskLimitsConfig({ ...RISK_CONFIG, maxOpenPositions: 0 })).toThrow();
    expect(() => parseRiskLimitsConfig({ ...RISK_CONFIG, maxDataAgeMs: -1 })).toThrow();
  });

  it("rejects malformed config at the engine boundary with RiskEngineError", () => {
    expect(() =>
      evaluateRisk(baseRequest(), { ...RISK_CONFIG, maxPortfolioHeatFraction: 5 }),
    ).toThrow(RiskEngineError);
  });
});
