/**
 * Portfolio heat, currency exposure and correlation tests (P11-03).
 *
 * Acceptance: new positions are denied when portfolio heat / correlation
 * caps are exceeded; the correlation model is documented and versioned
 * (`currency-leg-overlap-v1`); redundancy penalties are deterministic.
 */
import { describe, expect, it } from "vitest";

import {
  computePortfolioHeat,
  currencyLegsOfPosition,
  evaluateRisk,
  positionRiskAmountAccount,
  projectExposures,
  projectedHeatFraction,
  redundancyCounts,
  redundancyDenial,
  type RiskLimitsConfig,
} from "@/index";

import { baseRequest, openLong, RISK_CONFIG, usdConversion } from "./risk-fixture";

/** Relaxed caps for heat-focused tests (so only heat can trip). */
const HEAT_ONLY_CONFIG: RiskLimitsConfig = {
  ...RISK_CONFIG,
  maxPerInstrumentDirection: 10,
  maxPerStrategyInstrument: 10,
  maxCurrencyExposureFraction: 20,
  maxCorrelatedGroupExposureFraction: 20,
};

describe("portfolio heat (P11-03)", () => {
  it("attributes risk from each open position's OWN protective stop", () => {
    const position = openLong("pbpos_heat_1", 2900);
    expect(positionRiskAmountAccount(position)).toBeCloseTo(2900, 4);
    const heat = computePortfolioHeat([position], 100000);
    expect(heat.totalRiskAccount).toBeCloseTo(2900, 4);
    expect(heat.fraction).toBeCloseTo(0.029, 6);
    expect(heat.positions[0]?.positionId).toBe("pbpos_heat_1");
  });

  it("projected heat adds the candidate risk to the open heat", () => {
    expect(projectedHeatFraction([openLong("pbpos_h", 2900)], 300, 100000)).toBeCloseTo(0.032, 6);
  });

  it("denies a new position when projected heat exceeds the cap", () => {
    // open heat 2.9% + candidate risk 120 (40000 x 0.0030) = 3.02% > 3% cap
    const decision = evaluateRisk(
      baseRequest({
        openPositions: [openLong("pbpos_heat_1", 2900)],
        requestedQuantityUnits: 40000,
      }),
      HEAT_ONLY_CONFIG,
    );
    expect(decision.outcome).toBe("rejected");
    expect(decision.reasons).toEqual(["risk_portfolio_heat_cap"]);
  });

  it("allows a new position exactly at the heat cap (strict > convention)", () => {
    // open 2990 + candidate 10 = 3000 = 3% cap
    const decision = evaluateRisk(
      baseRequest({
        openPositions: [openLong("pbpos_heat_1", 2990)],
        requestedQuantityUnits: 3333.333333, // 3333.333333 x 0.003 = 10.0 risk
      }),
      HEAT_ONLY_CONFIG,
    );
    expect(decision.outcome).toBe("approved");
    expect(decision.riskAmountAccount).toBe(10);
  });

  it("empty portfolio heat is zero", () => {
    const heat = computePortfolioHeat([], 100000);
    expect(heat.totalRiskAccount).toBe(0);
    expect(heat.fraction).toBe(0);
    expect(heat.positions).toEqual([]);
  });
});

describe("currency-factor exposure (P11-03, currency-leg-overlap-v1)", () => {
  it("produces two signed legs for a standard FX position (long: +base / -quote)", () => {
    const legs = currencyLegsOfPosition({
      instrument: "EURUSD",
      direction: "long",
      quantityUnits: 10000,
      avgPrice: 1.1085,
      conversion: usdConversion(),
    });
    expect(legs).toEqual([
      { currency: "EUR", signedExposure: 11085 },
      { currency: "USD", signedExposure: -11085 },
    ]);
  });

  it("mirrors the legs for a short position", () => {
    const legs = currencyLegsOfPosition({
      instrument: "EURUSD",
      direction: "short",
      quantityUnits: 10000,
      avgPrice: 1.1085,
      conversion: usdConversion(),
    });
    expect(legs[0]?.currency).toBe("EUR");
    expect(legs[0]?.signedExposure).toBe(-11085);
    expect(legs[1]?.signedExposure).toBe(11085);
  });

  it("projects net and gross exposure per currency over the open snapshot", () => {
    // two long EURUSD opens (100k units each) + one long candidate (10k units):
    // USD stacks on the same leg (gross), EUR nets on the shared direction
    const projection = projectExposures(
      [openLong("pbpos_1", 300), openLong("pbpos_2", 300)],
      {
        instrument: "EURUSD",
        direction: "long",
        quantityUnits: 10000,
        avgPrice: 1.1085,
        conversion: usdConversion(),
      },
      100000,
    );
    const usd = projection.exposures.find((e) => e.currency === "USD");
    expect(projection.currencies).toEqual(["EUR", "USD"]);
    expect(usd?.gross).toBeCloseTo(2 * 110850 + 11085, 3); // 232785
    expect(Math.abs(usd?.net ?? 0)).toBeCloseTo(2 * 110850 + 11085, 3);
    expect(usd?.grossFraction).toBeCloseTo(2.32785, 5);
  });

  it("opposite-direction positions net out on the shared currency (no false positive)", () => {
    // equal-size long open + short candidate: USD/EUR nets cancel, gross stacks
    const projection = projectExposures(
      [openLong("pbpos_1", 300)], // 100k units
      {
        instrument: "EURUSD",
        direction: "short",
        quantityUnits: 100000,
        avgPrice: 1.1085,
        conversion: usdConversion(),
      },
      100000,
    );
    const usd = projection.exposures.find((e) => e.currency === "USD");
    expect(usd?.net).toBe(0);
    expect(usd?.gross).toBeCloseTo(2 * 110850, 3);
  });

  it("denies a new position breaching the correlated-group (gross) cap", () => {
    // candidate alone: gross USD 11085 / 100000 = 0.11085 > 0.1 cap
    // (net currency cap relaxed so ONLY the correlation cap can trip)
    const config: RiskLimitsConfig = {
      ...RISK_CONFIG,
      maxCurrencyExposureFraction: 20,
      maxCorrelatedGroupExposureFraction: 0.1,
    };
    const decision = evaluateRisk(baseRequest(), config);
    expect(decision.reasons).toEqual(["risk_correlation_cap"]);
  });

  it("denies a new position breaching the net currency exposure cap", () => {
    const config: RiskLimitsConfig = { ...RISK_CONFIG, maxCurrencyExposureFraction: 0.1 };
    const decision = evaluateRisk(baseRequest(), config);
    expect(decision.reasons).toEqual(["risk_currency_exposure_cap"]);
  });
});

describe("redundancy penalties (P11-03)", () => {
  it("counts same instrument+direction and same strategy+instrument+direction", () => {
    const counts = redundancyCounts([openLong("pbpos_1", 100), openLong("pbpos_2", 100)], {
      instrument: "EURUSD",
      direction: "long",
      strategyId: "trend-mtf-pullback",
    });
    expect(counts).toEqual({ perInstrumentDirection: 2, perStrategyInstrument: 2 });
  });

  it("denies a redundant same instrument+direction entry (candidate counts itself)", () => {
    const decision = evaluateRisk(
      baseRequest({ openPositions: [openLong("pbpos_1", 100)] }),
      RISK_CONFIG,
    );
    expect(decision.outcome).toBe("rejected");
    expect(decision.reasons).toEqual(["risk_redundant_position"]);
  });

  it("allows the opposite direction on the same instrument (no redundancy penalty)", () => {
    const opposite = openLong("pbpos_1", 100);
    const flipped = { ...opposite, direction: "short" as const, stopLoss: 1.1115 };
    const decision = evaluateRisk(baseRequest({ openPositions: [flipped] }), RISK_CONFIG);
    expect(decision.outcome).toBe("approved");
  });

  it("denies a redundant same strategy+instrument+direction when the instrument cap is raised", () => {
    const config: RiskLimitsConfig = { ...RISK_CONFIG, maxPerInstrumentDirection: 2 };
    const decision = evaluateRisk(baseRequest({ openPositions: [openLong("pbpos_1", 100)] }), config);
    expect(decision.reasons).toEqual(["risk_redundant_strategy"]);
  });

  it("a different strategy on the same instrument+direction is only instrument-redundant", () => {
    const candidate = {
      instrument: "EURUSD",
      direction: "long" as const,
      strategyId: "trend-mtf-pullback",
    };
    const counts = redundancyCounts([openLong("pbpos_1", 100, "mean-reversion-range")], candidate);
    expect(counts).toEqual({ perInstrumentDirection: 1, perStrategyInstrument: 0 });
    expect(
      redundancyDenial([openLong("pbpos_1", 100, "mean-reversion-range")], candidate, {
        ...RISK_CONFIG,
        maxPerInstrumentDirection: 2,
      }),
    ).toBeNull();
  });
});
