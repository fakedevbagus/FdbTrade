/**
 * Regime contract tests (P04-01).
 *
 * Valid/malformed/boundary cases for `regimeAssessmentSchema`: canonical
 * states, confidence bounds, reason-code ordering, degraded-state rules
 * (unknown is first-class and fail-closed), determinism.
 */
import { describe, expect, it } from "vitest";

import {
  DEGRADATION_REASON_CODES,
  REGIME_REASON_CODES,
  REGIME_STATES,
  isDegradedAssessment,
  normalizeRegimeAssessment,
  regimeAssessmentSchema,
  type RegimeAssessment,
} from "@/index";

function validAssessment(): RegimeAssessment {
  return {
    instrument: "EURUSD",
    timeframe: "1h",
    eventTimeUtc: "2026-09-08T10:00:00.000Z",
    state: "trend",
    confidence: 0.75,
    reasonCodes: ["adx_trend_evidence", "slope_confirms_trend"],
    classifierId: "regime-rule-baseline",
    classifierVersion: "1.0.0",
    inputs: { adx: 30.5, atr_fraction: 0.0008, slope_pips: 1.2, vol_ratio: 1.1 },
  };
}

describe("regimeAssessmentSchema (P04-01)", () => {
  it("accepts a valid assessment (happy path)", () => {
    const parsed = regimeAssessmentSchema.parse(validAssessment());
    expect(parsed.state).toBe("trend");
    expect(parsed.confidence).toBeCloseTo(0.75, 12);
  });

  it("accepts confidence boundary values 0 and 1", () => {
    regimeAssessmentSchema.parse({ ...validAssessment(), confidence: 0 });
    regimeAssessmentSchema.parse({ ...validAssessment(), confidence: 1 });
  });

  it("rejects out-of-range confidence (malformed)", () => {
    expect(() => regimeAssessmentSchema.parse({ ...validAssessment(), confidence: -0.1 })).toThrow();
    expect(() => regimeAssessmentSchema.parse({ ...validAssessment(), confidence: 1.1 })).toThrow();
    expect(() => regimeAssessmentSchema.parse({ ...validAssessment(), confidence: "high" })).toThrow();
  });

  it("rejects unknown state / bad enum values (malformed)", () => {
    expect(() => regimeAssessmentSchema.parse({ ...validAssessment(), state: "chaos" })).toThrow();
    expect(() => regimeAssessmentSchema.parse({ ...validAssessment(), timeframe: "2h" })).toThrow();
    expect(() => regimeAssessmentSchema.parse({ ...validAssessment(), instrument: "eu usd!" })).toThrow();
  });

  it("rejects non-UTC or wrong-precision eventTimeUtc", () => {
    expect(() =>
      regimeAssessmentSchema.parse({ ...validAssessment(), eventTimeUtc: "2026-09-08T10:00:00+02:00" }),
    ).toThrow();
    expect(() =>
      regimeAssessmentSchema.parse({ ...validAssessment(), eventTimeUtc: "2026-09-08T10:00:00Z" }),
    ).toThrow(); // must be millisecond precision
  });

  it("rejects empty, unsorted or duplicated reasonCodes (malformed)", () => {
    expect(() => regimeAssessmentSchema.parse({ ...validAssessment(), reasonCodes: [] })).toThrow();
    expect(() =>
      regimeAssessmentSchema.parse({
        ...validAssessment(),
        reasonCodes: ["slope_confirms_trend", "adx_trend_evidence"],
      }),
    ).toThrow();
    expect(() =>
      regimeAssessmentSchema.parse({
        ...validAssessment(),
        reasonCodes: ["adx_trend_evidence", "adx_trend_evidence"],
      }),
    ).toThrow();
  });

  it("rejects unknown reason codes (fail closed)", () => {
    expect(() =>
      regimeAssessmentSchema.parse({
        ...validAssessment(),
        reasonCodes: ["made_up_code"],
      } as unknown as RegimeAssessment),
    ).toThrow();
  });

  it("unknown state requires confidence 0 and a degradation code (degraded first-class)", () => {
    const degraded = normalizeRegimeAssessment({
      ...validAssessment(),
      state: "unknown",
      confidence: 0,
      reasonCodes: ["insufficient_history", "vol_baseline_unavailable"],
    });
    expect(degraded.state).toBe("unknown");
    expect(isDegradedAssessment(degraded)).toBe(true);
    // unknown with nonzero confidence -> reject
    expect(() =>
      regimeAssessmentSchema.parse({
        ...validAssessment(),
        state: "unknown",
        confidence: 0.5,
        reasonCodes: ["missing_feature"],
      }),
    ).toThrow();
    // unknown without degradation code -> reject
    expect(() =>
      regimeAssessmentSchema.parse({
        ...validAssessment(),
        state: "unknown",
        confidence: 0,
        reasonCodes: ["adx_dead_zone"],
      }),
    ).toThrow();
  });

  it("degradation codes are forbidden on non-unknown states (fail closed)", () => {
    expect(() =>
      regimeAssessmentSchema.parse({
        ...validAssessment(),
        reasonCodes: ["adx_trend_evidence", "missing_feature", "slope_confirms_trend"],
      }),
    ).toThrow();
  });

  it("normalizeRegimeAssessment sorts and dedupes reason codes deterministically", () => {
    const a = normalizeRegimeAssessment({
      ...validAssessment(),
      reasonCodes: ["slope_confirms_trend", "adx_trend_evidence", "slope_confirms_trend"],
    });
    expect(a.reasonCodes).toEqual(["adx_trend_evidence", "slope_confirms_trend"]);
  });

  it("rejects unknown extra keys (strict schema)", () => {
    expect(() =>
      regimeAssessmentSchema.parse({ ...validAssessment(), extra: 1 } as unknown as RegimeAssessment),
    ).toThrow();
  });

  it("state set matches the frozen canonical contract", () => {
    expect(REGIME_STATES).toEqual([
      "trend",
      "range",
      "high_volatility",
      "low_volatility",
      "transition",
      "unknown",
    ]);
    expect(DEGRADATION_REASON_CODES.length).toBeGreaterThan(0);
    for (const code of DEGRADATION_REASON_CODES) {
      expect(REGIME_REASON_CODES).toContain(code);
    }
  });
});