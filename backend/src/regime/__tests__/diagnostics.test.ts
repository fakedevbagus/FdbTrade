/**
 * Regime diagnostics tests (P04-04).
 *
 * Acceptance: "Research dashboard/API can inspect regime states and
 * anomalies." Covers: distribution/transition/episode math on hand
 * fixtures, every quality flag, empty window, schema round-trip,
 * fail-closed guards, determinism.
 */
import { describe, expect, it } from "vitest";

import {
  REGIME_STATES,
  regimeDiagnosticsSchema,
  type RegimeAssessment,
  type RegimeReasonCode,
  type RegimeState,
} from "@fdbtrade/contracts";

import {
  DEFAULT_DIAGNOSTICS_CONFIG,
  computeRegimeDiagnostics,
  type RegimeDiagnosticsConfig,
} from "@/regime/diagnostics";

function assessment(
  i: number,
  state: RegimeState,
  confidence = 0.8,
): RegimeAssessment {
  const day = String(1 + Math.floor(i / 24)).padStart(2, "0");
  const hh = String(i % 24).padStart(2, "0");
  const unknown = state === "unknown";
  return {
    instrument: "EURUSD",
    timeframe: "1h",
    eventTimeUtc: `2026-09-${day}T${hh}:00:00.000Z`,
    state,
    confidence: unknown ? 0 : confidence,
    reasonCodes: unknown
      ? (["insufficient_history", "vol_baseline_unavailable"] as RegimeReasonCode[])
      : (["adx_trend_evidence", "slope_confirms_trend"] as RegimeReasonCode[]),
    classifierId: "regime-rule-baseline",
    classifierVersion: "1.0.0",
    inputs: { adx: 30 },
  };
}

function states(...spec: (RegimeState | [RegimeState, number])[]): RegimeAssessment[] {
  const out: RegimeAssessment[] = [];
  let i = 0;
  for (const item of spec) {
    if (Array.isArray(item)) {
      out.push(assessment(i, item[0], item[1]));
    } else {
      out.push(assessment(i, item));
    }
    i += 1;
  }
  return out;
}

function configWith(overrides: Partial<RegimeDiagnosticsConfig>): RegimeDiagnosticsConfig {
  return { ...DEFAULT_DIAGNOSTICS_CONFIG, ...overrides };
}

const OPTS = { instrument: "EURUSD", timeframe: "1h" } as const;

describe("computeRegimeDiagnostics math (P04-04)", () => {
  it("computes counts, shares, transitions, episodes and current episode", () => {
    // trend trend range trend unknown trend -> 5 transitions, episodes:
    // trend[2], range[1], trend[1], unknown[1], trend[1] (current).
    const d = computeRegimeDiagnostics(
      states("trend", "trend", "range", "trend", "unknown", "trend"),
      OPTS,
    );
    expect(d.bars).toBe(6);
    expect(d.counts.trend).toBe(4);
    expect(d.counts.range).toBe(1);
    expect(d.counts.unknown).toBe(1);
    expect(d.shares.trend).toBeCloseTo(4 / 6, 12);
    expect(Object.values(d.counts).reduce((a, b) => a + b, 0)).toBe(6);
    expect(d.totalTransitions).toBe(4);
    expect(d.transitions).toEqual([
      { from: "trend", to: "range", count: 1 },
      { from: "trend", to: "unknown", count: 1 },
      { from: "range", to: "trend", count: 1 },
      { from: "unknown", to: "trend", count: 1 },
    ]);
    expect(d.episodes.trend).toEqual({ episodes: 3, bars: 4, meanBars: 4 / 3, maxBars: 2 });
    expect(d.episodes.range).toEqual({ episodes: 1, bars: 1, meanBars: 1, maxBars: 1 });
    expect(d.episodes.unknown).toEqual({ episodes: 1, bars: 1, meanBars: 1, maxBars: 1 });
    expect(d.episodes.low_volatility).toEqual({ episodes: 0, bars: 0, meanBars: null, maxBars: 0 });
    expect(d.currentEpisode).toEqual({
      state: "trend",
      bars: 1,
      sinceTimeUtc: "2026-09-01T05:00:00.000Z",
    });
    expect(d.meanConfidence).toBeCloseTo((5 * 0.8 + 0) / 6, 12);
    expect(d.fromTimeUtc).toBe("2026-09-01T00:00:00.000Z");
    expect(d.toTimeUtc).toBe("2026-09-01T05:00:00.000Z");
  });

  it("empty window -> empty_window flag, zeros, nulls (boundary)", () => {
    const d = computeRegimeDiagnostics([], OPTS);
    expect(d.bars).toBe(0);
    expect(d.totalTransitions).toBe(0);
    expect(d.meanConfidence).toBeNull();
    expect(d.currentEpisode).toBeNull();
    expect(d.fromTimeUtc).toBeNull();
    for (const s of REGIME_STATES) {
      expect(d.counts[s]).toBe(0);
      expect(d.shares[s]).toBe(0);
      expect(d.episodes[s].episodes).toBe(0);
    }
    expect(d.qualityFlags).toEqual([
      { code: "empty_window", detail: "no assessments in window" },
    ]);
    expect(() => regimeDiagnosticsSchema.parse(d)).not.toThrow();
  });

  it("single assessment: one episode, no transitions (boundary)", () => {
    const d = computeRegimeDiagnostics(states("trend"), OPTS);
    expect(d.bars).toBe(1);
    expect(d.totalTransitions).toBe(0);
    expect(d.currentEpisode).toEqual({
      state: "trend",
      bars: 1,
      sinceTimeUtc: "2026-09-01T00:00:00.000Z",
    });
    expect(d.episodes.trend).toEqual({ episodes: 1, bars: 1, meanBars: 1, maxBars: 1 });
    expect(d.qualityFlags.map((f) => f.code)).not.toContain("regime_churn");
    expect(d.qualityFlags.map((f) => f.code)).not.toContain("single_state_window");
  });

  it("validates against the contract schema (round-trip)", () => {
    const d = computeRegimeDiagnostics(states("trend", "range", "trend"), OPTS);
    expect(() => regimeDiagnosticsSchema.parse(d)).not.toThrow();
  });
});

describe("quality flags (P04-04)", () => {
  it("flags high_unknown_share when unknown dominates", () => {
    const seq = states("unknown", "unknown", "unknown", "unknown", "unknown", "trend");
    const d = computeRegimeDiagnostics(seq, OPTS);
    expect(d.qualityFlags.map((f) => f.code)).toContain("high_unknown_share");
  });

  it("flags regime_churn when transitions per bar exceed the rate", () => {
    // Alternating trend/range: 9 transitions over 10 bars = 1.0 > 0.25.
    const seq: RegimeAssessment[] = [];
    for (let i = 0; i < 10; i += 1) {
      seq.push(assessment(i, i % 2 === 0 ? "trend" : "range"));
    }
    const d = computeRegimeDiagnostics(seq, OPTS);
    expect(d.qualityFlags.map((f) => f.code)).toContain("regime_churn");
  });

  it("flags single_state_window when only one state appears", () => {
    const seq = states("trend", "trend", "trend", "trend");
    const d = computeRegimeDiagnostics(seq, OPTS);
    expect(d.qualityFlags.map((f) => f.code)).toContain("single_state_window");
  });

  it("flags low_confidence when the mean is below the floor", () => {
    const seq = states(["trend", 0.3], ["trend", 0.4], ["range", 0.5]);
    const d = computeRegimeDiagnostics(seq, OPTS);
    expect(d.meanConfidence).toBeCloseTo(0.4, 12);
    expect(d.qualityFlags.map((f) => f.code)).toContain("low_confidence");
  });

  it("flags stale_tail when the trailing unknown run is long enough", () => {
    const seq = states("trend", "unknown", "unknown", "unknown");
    const d = computeRegimeDiagnostics(seq, OPTS);
    expect(d.qualityFlags.map((f) => f.code)).toContain("stale_tail");
    // Two trailing unknowns stay below the default threshold of 3.
    const short = computeRegimeDiagnostics(states("trend", "unknown", "unknown"), OPTS);
    expect(short.qualityFlags.map((f) => f.code)).not.toContain("stale_tail");
  });

  it("flags are sorted and deterministic (idempotency)", () => {
    const seq = states("trend", "unknown", "unknown", "unknown", "trend", "range");
    const a = computeRegimeDiagnostics(seq, OPTS);
    const b = computeRegimeDiagnostics(seq, OPTS);
    expect(a).toEqual(b);
    const codes = a.qualityFlags.map((f) => f.code);
    expect(codes).toEqual([...codes].sort());
  });

  it("threshold overrides are honored (config)", () => {
    const seq = states("trend", "unknown", "trend", "unknown");
    // unknown share 0.5: below 0.6 -> not flagged.
    const lenient = computeRegimeDiagnostics(seq, {
      ...OPTS,
      config: configWith({ unknownShareThreshold: 0.6 }),
    });
    expect(lenient.qualityFlags.map((f) => f.code)).not.toContain("high_unknown_share");
    const strict = computeRegimeDiagnostics(seq, {
      ...OPTS,
      config: configWith({ unknownShareThreshold: 0.4 }),
    });
    expect(strict.qualityFlags.map((f) => f.code)).toContain("high_unknown_share");
  });
});

describe("diagnostics failure paths (P04-04)", () => {
  it("rejects mixed identity and bad ordering (fail closed)", () => {
    const mixed = states("trend", "range");
    expect(() =>
      computeRegimeDiagnostics(mixed, { instrument: "GBPUSD", timeframe: "1h" }),
    ).toThrow();
    expect(() =>
      computeRegimeDiagnostics([...mixed.slice(1), ...mixed.slice(0, 1)], OPTS),
    ).toThrow();
    expect(() =>
      computeRegimeDiagnostics(mixed, { instrument: "", timeframe: "1h" }),
    ).toThrow();
  });
});