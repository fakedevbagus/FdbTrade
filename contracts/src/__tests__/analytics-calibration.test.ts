/**
 * Calibration analytics tests (P12-02, ADR-0023).
 *
 * Acceptance: the calibration view distinguishes insufficient sample sizes
 * from stable estimates. Confidence is MEASURED against outcomes — the
 * suite pins that no metric claims confidence equals win probability.
 */
import { describe, expect, it } from "vitest";

import {
  AnalyticsError,
  ANALYTICS_CALIBRATION_BIN_EDGES,
  calibrationBinIndexFor,
  calibrationObservationFromTrade,
  calibrationObservationSchema,
  computeCalibrationReport,
  sampleStatusFor,
  type CalibrationObservation,
} from "@/index";

import { rec } from "./analytics-outcome.test";

function obs(overrides: Partial<CalibrationObservation> = {}): CalibrationObservation {
  return calibrationObservationSchema.parse({
    tradeId: "trd-o1",
    strategyId: "trend-mtf-pullback",
    strategyVersion: "1.0.0",
    configVersion: "1.0.0",
    instrument: "EURUSD",
    timeframe: "1h",
    regimeState: "trend",
    forecastModelId: "ensemble-v1",
    probability: 0.6,
    outcome: 1,
    decidedAtUtc: "2026-09-08T09:00:00.000Z",
    resolvedAtUtc: "2026-09-08T10:00:00.000Z",
    ...overrides,
  });
}

describe("calibration analytics (P12-02)", () => {
  it("builds an observation from a trade record (confidence measured, not assumed)", () => {
    const trade = rec({ tradeId: "trd-cal", confidence: 0.7, realizedPnl: 100 });
    const o = calibrationObservationFromTrade(trade, "ensemble-v1");
    expect(o.probability).toBe(0.7);
    expect(o.outcome).toBe(1);
    const loser = rec({ tradeId: "trd-los", confidence: 0.7, realizedPnl: -50 });
    expect(calibrationObservationFromTrade(loser, "ensemble-v1").outcome).toBe(0);
  });

  it("refuses a trade with no recorded confidence (nothing to calibrate)", () => {
    const blind = rec({ tradeId: "trd-nb", confidence: null });
    expect(() => calibrationObservationFromTrade(blind, "ensemble-v1")).toThrow(AnalyticsError);
  });

  it("computes Brier, log-loss, expected-vs-realized over a known sample", () => {
    const observations = [
      obs({ tradeId: "obs1", probability: 0.8, outcome: 1 }),
      obs({ tradeId: "obs2", probability: 0.8, outcome: 0 }),
      obs({ tradeId: "obs3", probability: 0.6, outcome: 1 }),
      obs({ tradeId: "obs4", probability: 0.6, outcome: 1 }),
    ];
    const r = computeCalibrationReport(observations, { reportId: "cal-1" });
    // Brier: (0.04 + 0.64 + 0.16 + 0.16) / 4 = 0.25
    expect(r.brierScore).toBeCloseTo(0.25, 6);
    expect(r.expectedRate).toBeCloseTo(0.7, 6);
    expect(r.realizedRate).toBeCloseTo(0.75, 6);
    expect(r.expectedRealizedGap).toBeCloseTo(0.05, 6);
    expect(r.sampleSize).toBe(4);
    expect(r.forecastModelId).toBe("ensemble-v1");
    expect(r.logLoss).not.toBeNull();
    expect(Number.isFinite(r.logLoss!)).toBe(true);
  });

  it("clamps log-loss so p=0/p=1 stay finite (frozen epsilon recorded)", () => {
    const observations = [
      obs({ tradeId: "trd-b1", probability: 0, outcome: 0 }),
      obs({ tradeId: "trd-b2", probability: 1, outcome: 1 }),
    ];
    const r = computeCalibrationReport(observations);
    expect(r.logLoss).not.toBeNull();
    expect(Number.isFinite(r.logLoss!)).toBe(true);
    expect(r.logLossEpsilon).toBeGreaterThan(0);
    // Correct extremes: loss ~ epsilon only.
    expect(r.logLoss!).toBeLessThan(1e-6);
    expect(r.brierScore).toBe(0);
  });

  it("penalizes confident-wrong forecasts with a finite but large log-loss", () => {
    const observations = [obs({ tradeId: "trd-cw1", probability: 0, outcome: 1 })];
    const r = computeCalibrationReport(observations);
    expect(r.logLoss!).toBeGreaterThan(20); // ~ -ln(1e-12)
    expect(Number.isFinite(r.logLoss!)).toBe(true);
  });

  it("distinguishes insufficient bin samples from stable estimates", () => {
    const thin = Array.from({ length: 3 }, (_, i) =>
      obs({ tradeId: `thin-${i}`, probability: 0.6, outcome: 1 }),
    );
    const stable = Array.from({ length: 12 }, (_, i) =>
      obs({ tradeId: `stbl-${i}`, probability: 0.6, outcome: i % 2 }),
    );
    const thinReport = computeCalibrationReport(thin, { minBinSample: 10 });
    const stableReport = computeCalibrationReport(stable, { minBinSample: 10 });
    expect(sampleStatusFor(3, 10)).toBe("insufficient");
    expect(sampleStatusFor(10, 10)).toBe("stable");
    expect(thinReport.sampleStatus).toBe("insufficient");
    expect(stableReport.sampleStatus).toBe("stable");
    const bin = (r: ReturnType<typeof computeCalibrationReport>) =>
      r.reliabilityBins.find((b) => b.lower === 0.6)!;
    expect(bin(thinReport).sampleStatus).toBe("insufficient");
    expect(bin(stableReport).sampleStatus).toBe("stable");
    expect(bin(stableReport).realizedRate).toBeCloseTo(0.5, 6);
  });

  it("bins by the frozen edges (upper-exclusive except the last, inclusive)", () => {
    expect(calibrationBinIndexFor(0)).toBe(0);
    expect(calibrationBinIndexFor(0.19)).toBe(0);
    expect(calibrationBinIndexFor(0.2)).toBe(1);
    expect(calibrationBinIndexFor(0.8)).toBe(4);
    expect(calibrationBinIndexFor(1)).toBe(4);
    expect(() => calibrationBinIndexFor(1.2)).toThrow(AnalyticsError);
    expect(() => calibrationBinIndexFor(-0.1)).toThrow(AnalyticsError);
    expect(ANALYTICS_CALIBRATION_BIN_EDGES).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });

  it("produces all bins with edges even for an empty sample", () => {
    const r = computeCalibrationReport([]);
    expect(r.sampleSize).toBe(0);
    expect(r.sampleStatus).toBe("insufficient");
    expect(r.brierScore).toBeNull();
    expect(r.logLoss).toBeNull();
    expect(r.expectedRate).toBeNull();
    expect(r.realizedRate).toBeNull();
    expect(r.reliabilityBins).toHaveLength(5);
    expect(r.reliabilityBins.every((b) => b.sampleSize === 0 && b.meanProbability === null)).toBe(true);
  });

  it("filters observations by strategy, instrument, timeframe, regime", () => {
    const observations = [
      obs({ tradeId: "trd-f1", strategyId: "alpha", instrument: "EURUSD", timeframe: "1h", regimeState: "trend" }),
      obs({ tradeId: "trd-f2", strategyId: "beta", instrument: "GBPUSD", timeframe: "15m", regimeState: "range" }),
    ];
    const r = computeCalibrationReport(observations, {
      filter: { strategyIds: ["alpha"], instruments: ["EURUSD"], timeframes: ["1h"], regimeStates: ["trend"] },
    });
    expect(r.sampleSize).toBe(1);
    expect(r.realizedRate).toBe(1);
  });

  it("rejects mixed forecast models and malformed observations (fail closed)", () => {
    expect(() =>
      computeCalibrationReport([
        obs({ tradeId: "trd-m1" }),
        obs({ tradeId: "trd-m2", forecastModelId: "other-model" }),
      ]),
    ).toThrow(AnalyticsError);
    expect(() =>
      computeCalibrationReport([obs({ tradeId: "bad", resolvedAtUtc: "2026-09-08T08:00:00.000Z" })]),
    ).toThrow();
  });

  it("rejects malformed options (minBinSample, logLossEpsilon, probability range)", () => {
    expect(() => computeCalibrationReport([obs()], { minBinSample: 0 })).toThrow(AnalyticsError);
    expect(() => computeCalibrationReport([obs()], { logLossEpsilon: 0 })).toThrow(AnalyticsError);
    expect(() => computeCalibrationReport([obs()], { logLossEpsilon: 0.9 })).toThrow(AnalyticsError);
  });

  it("is deterministic for the same input (idempotency)", () => {
    const observations = [
      obs({ tradeId: "trd-i1", probability: 0.55, outcome: 1 }),
      obs({ tradeId: "trd-i2", probability: 0.65, outcome: 0 }),
    ];
    const r1 = computeCalibrationReport(observations, { reportId: "idem-cal" });
    const r2 = computeCalibrationReport([...observations].reverse(), { reportId: "idem-cal" });
    expect(r1).toEqual(r2);
  });
});


