/**
 * Deterministic baseline regime classifier tests (P04-02).
 *
 * Acceptance: "Fixture datasets produce deterministic regimes; boundary
 * cases are covered." Covers: synthetic trend/range/vol-spike fixtures,
 * warmup (unknown/insufficient_history), missing features, dead zone,
 * confidence bounds, determinism, no-look-ahead truncation invariance and
 * fail-closed config guards.
 */
import { describe, expect, it } from "vitest";

import { getInstrument, type Candle, type RegimeAssessment } from "@fdbtrade/contracts";

import {
  DEFAULT_REGIME_CONFIG,
  REGIME_CLASSIFIER_ID,
  classifyRegimes,
  regimeFeatureSeriesFromCandles,
  type RegimeClassifierConfig,
  type RegimeFeatureSeries,
} from "@/regime/classifier";

const PIP = getInstrument("EURUSD").precision.pip;

function makeCandle(i: number, open: number, close: number, rangePad: number): Candle {
  const day = String(1 + Math.floor(i / 24)).padStart(2, "0");
  const hh = String(i % 24).padStart(2, "0");
  return {
    instrument: "EURUSD",
    timeframe: "1h",
    timestamp: `2026-09-${day}T${hh}:00:00.000Z`,
    open,
    high: Math.max(open, close) + rangePad,
    low: Math.min(open, close) - rangePad,
    close,
    volume: null,
  };
}

/** Deterministic 3-phase fixture: flat range -> steady uptrend -> vol spike. */
function fixtureCandles(): Candle[] {
  const candles: Candle[] = [];
  let prev = 1.1;
  for (let i = 0; i < 180; i += 1) {
    let close: number;
    let pad: number;
    if (i < 60) {
      close = 1.1 + (i % 2 === 0 ? 0.0008 : -0.0008); // flat range
      pad = 0.0004;
    } else if (i < 140) {
      close = prev + 0.002; // steady uptrend
      pad = 0.0006;
    } else {
      close = prev + (i % 2 === 0 ? 0.006 : -0.006); // vol spike, no direction
      pad = 0.004;
    }
    candles.push(makeCandle(i, prev, close, pad));
    prev = close;
  }
  return candles;
}

function featuresFrom(candles: Candle[]): RegimeFeatureSeries {
  return regimeFeatureSeriesFromCandles(candles, {
    adxPeriod: 14,
    atrPeriod: 14,
    slopeWindow: 20,
    pip: PIP,
  });
}

function classifyFeatures(
  features: RegimeFeatureSeries,
  config?: Partial<RegimeClassifierConfig>,
): RegimeAssessment[] {
  return classifyRegimes(features, {
    instrument: "EURUSD",
    timeframe: "1h",
    config: { ...DEFAULT_REGIME_CONFIG, ...config },
  });
}

/** Ascending hourly UTC timestamps from 2026-09-01T00:00:00.000Z. */
function hourlyTimestamps(count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const day = String(1 + Math.floor(i / 24)).padStart(2, "0");
    const hh = String(i % 24).padStart(2, "0");
    return `2026-09-${day}T${hh}:00:00.000Z`;
  });
}

describe("regimeFeatureSeriesFromCandles (P04-02)", () => {
  it("builds aligned series from candles (happy path)", () => {
    const candles = fixtureCandles();
    const f = featuresFrom(candles);
    expect(f.timestamps).toHaveLength(candles.length);
    expect(f.adx).toHaveLength(candles.length);
    expect(f.atrFraction).toHaveLength(candles.length);
    expect(f.slopePips).toHaveLength(candles.length);
    expect(f.adx[0]).toBeNull(); // warmup
    expect(f.adx[40]).not.toBeNull();
    expect(f.atrFraction[20]).not.toBeNull();
    expect(f.slopePips[25]).not.toBeNull();
  });

  it("empty input -> empty series (boundary)", () => {
    const f = regimeFeatureSeriesFromCandles([], {
      adxPeriod: 14,
      atrPeriod: 14,
      slopeWindow: 20,
      pip: PIP,
    });
    expect(f.timestamps).toEqual([]);
  });

  it("rejects invalid options and unsorted candles (fail closed)", () => {
    const candles = fixtureCandles().slice(0, 5);
    expect(() =>
      regimeFeatureSeriesFromCandles(candles, { adxPeriod: 0, atrPeriod: 14, slopeWindow: 20, pip: PIP }),
    ).toThrow();
    expect(() =>
      regimeFeatureSeriesFromCandles(candles, { adxPeriod: 14, atrPeriod: 14, slopeWindow: 1, pip: PIP }),
    ).toThrow();
    expect(() =>
      regimeFeatureSeriesFromCandles(candles, { adxPeriod: 14, atrPeriod: 14, slopeWindow: 20, pip: 0 }),
    ).toThrow();
    const unsorted = [candles[1], candles[0]];
    expect(() =>
      regimeFeatureSeriesFromCandles(unsorted, { adxPeriod: 14, atrPeriod: 14, slopeWindow: 20, pip: PIP }),
    ).toThrow();
  });
});

describe("classifyRegimes fixtures (P04-02)", () => {
  it("classifies the deterministic 3-phase fixture", () => {
    const assessments = classifyFeatures(featuresFrom(fixtureCandles()));
    expect(assessments).toHaveLength(180);

    // Warmup: every early bar is unknown with confidence 0.
    expect(assessments[0].state).toBe("unknown");
    expect(assessments[0].confidence).toBe(0);
    expect(assessments[0].reasonCodes).toContain("missing_feature");
    // Before the 50-bar vol baseline exists -> insufficient_history.
    const insufficient = assessments.filter((a) => a.reasonCodes.includes("insufficient_history"));
    expect(insufficient.length).toBeGreaterThan(0);

    // Uptrend phase (after warmup) must classify as trend with slope evidence.
    const trendBars = assessments.filter((a) => a.state === "trend");
    expect(trendBars.length).toBeGreaterThan(0);
    for (const t of trendBars) {
      expect(t.reasonCodes).toContain("adx_trend_evidence");
      expect(t.reasonCodes).toContain("slope_confirms_trend");
      expect(t.confidence).toBeGreaterThan(0);
    }

    // Vol-spike phase must classify as high_volatility.
    const highVol = assessments.filter((a) => a.state === "high_volatility");
    expect(highVol.length).toBeGreaterThan(0);
    for (const h of highVol) {
      expect(h.reasonCodes).toContain("vol_expansion");
      expect(h.inputs.vol_ratio).not.toBeNull();
      expect(h.inputs.vol_ratio as number).toBeGreaterThanOrEqual(DEFAULT_REGIME_CONFIG.highVolRatio);
    }
  });

  it("classifies oscillating series as range (low ADX)", () => {
    const candles: Candle[] = [];
    let prev: number | null = null;
    for (let i = 0; i < 120; i += 1) {
      const close = 1.1 + 0.0012 * Math.sin(i / 3);
      const open = prev ?? close;
      const pad = 0.0003 + 0.0002 * (i % 3);
      candles.push({
        instrument: "EURUSD",
        timeframe: "1h",
        timestamp: hourlyTimestamps(120)[i],
        open,
        high: Math.max(open, close) + pad,
        low: Math.min(open, close) - pad,
        close,
        volume: null,
      });
      prev = close;
    }
    const assessments = classifyFeatures(featuresFrom(candles));
    const rangeBars = assessments.filter((a) => a.state === "range");
    expect(rangeBars.length).toBeGreaterThan(0);
    for (const r of rangeBars) {
      expect(r.reasonCodes).toEqual(["adx_range_evidence"]);
      expect(r.confidence).toBeGreaterThan(0);
    }
  });

  it("every assessment carries classifier identity; degraded bars fail closed", () => {
    const assessments = classifyFeatures(featuresFrom(fixtureCandles()));
    for (const a of assessments) {
      expect(a.classifierId).toBe(REGIME_CLASSIFIER_ID);
      expect(a.classifierVersion).toMatch(/^\d+\.\d+\.\d+$/);
      if (a.state === "unknown") {
        expect(a.confidence).toBe(0);
        expect(
          a.reasonCodes.some((c) =>
            ["insufficient_history", "missing_feature", "stale_context", "missing_context"].includes(c),
          ),
        ).toBe(true);
      } else {
        expect(a.confidence).toBeGreaterThan(0);
        expect(a.confidence).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("classifier boundaries + failure paths (P04-02)", () => {
  it("dead-zone ADX yields transition (boundary between thresholds)", () => {
    // volWindow 5 baseline of identical atrFraction -> neutral vol ratio 1.
    const warmupBars = 6;
    const adx = [...Array(warmupBars).fill(null), 22.5, 24.9];
    const atrFraction = Array(warmupBars + 2).fill(0.0005);
    const slopePips: (number | null)[] = [...Array(warmupBars).fill(null), 2, 2];
    const assessments = classifyRegimes(
      { timestamps: hourlyTimestamps(warmupBars + 2), adx, atrFraction, slopePips },
      { instrument: "EURUSD", timeframe: "1h", config: { ...DEFAULT_REGIME_CONFIG, volWindow: 5 } },
    );
    expect(assessments[warmupBars].state).toBe("transition");
    expect(assessments[warmupBars].reasonCodes).toEqual(["adx_dead_zone"]);
    expect(assessments[warmupBars].confidence).toBeCloseTo(0.5, 12);
    expect(assessments[warmupBars + 1].state).toBe("transition");
  });

  it("trend evidence with conflicting slope yields transition (boundary)", () => {
    const warmupBars = 6;
    const adx = [...Array(warmupBars).fill(null), 30];
    const atrFraction = Array(warmupBars + 1).fill(0.0005);
    const slopePips: (number | null)[] = [...Array(warmupBars).fill(null), 0.1]; // < minSlopePips
    const assessments = classifyRegimes(
      { timestamps: hourlyTimestamps(warmupBars + 1), adx, atrFraction, slopePips },
      { instrument: "EURUSD", timeframe: "1h", config: { ...DEFAULT_REGIME_CONFIG, volWindow: 5 } },
    );
    expect(assessments[warmupBars].state).toBe("transition");
    expect(assessments[warmupBars].reasonCodes).toEqual([
      "adx_trend_evidence",
      "slope_conflicts_trend",
    ]);
  });

  it("vol expansion/ contraction threshold boundaries", () => {
    const warmupBars = 6;
    const adx = [...Array(warmupBars).fill(null), 15, 15];
    const atrFraction = [
      ...Array(warmupBars).fill(0.0005),
      0.0005 * 1.5, // exactly highVolRatio -> high_volatility (>=)
      0.0005 * 0.6, // exactly lowVolRatio -> low_volatility (<=)
    ];
    const slopePips: (number | null)[] = [...Array(warmupBars).fill(null), 1, 1];
    const assessments = classifyRegimes(
      { timestamps: hourlyTimestamps(warmupBars + 2), adx, atrFraction, slopePips },
      { instrument: "EURUSD", timeframe: "1h", config: { ...DEFAULT_REGIME_CONFIG, volWindow: 5 } },
    );
    expect(assessments[warmupBars].state).toBe("high_volatility");
    expect(assessments[warmupBars].confidence).toBeCloseTo(0, 12); // at the threshold
    expect(assessments[warmupBars + 1].state).toBe("low_volatility");
    // Baseline of the second bar includes the previous elevated bar, so the
    // ratio lands below lowVolRatio but not at zero confidence.
    expect(assessments[warmupBars + 1].confidence).toBeGreaterThan(0);
    expect(assessments[warmupBars + 1].confidence).toBeLessThanOrEqual(1);
  });

  it("rejects malformed input (fail closed)", () => {
    expect(() =>
      classifyRegimes(
        { timestamps: hourlyTimestamps(2), adx: [1, 1], atrFraction: [1, 1], slopePips: [1] },
        { instrument: "EURUSD", timeframe: "1h" },
      ),
    ).toThrow(); // length mismatch
    expect(() =>
      classifyRegimes(
        { timestamps: ["2026-09-08T10:00:00Z"], adx: [1], atrFraction: [1], slopePips: [1] },
        { instrument: "EURUSD", timeframe: "1h" },
      ),
    ).toThrow(); // non-millisecond UTC instant
    expect(() =>
      classifyRegimes(
        {
          timestamps: ["2026-09-08T10:00:00.000Z", "2026-09-08T10:00:00.000Z"],
          adx: [1, 1],
          atrFraction: [1, 1],
          slopePips: [1, 1],
        },
        { instrument: "EURUSD", timeframe: "1h" },
      ),
    ).toThrow(); // duplicate timestamps
    expect(() =>
      classifyRegimes(
        { timestamps: hourlyTimestamps(2), adx: [1, 1], atrFraction: [1, 1], slopePips: [1, 1] },
        { instrument: "", timeframe: "1h" },
      ),
    ).toThrow(); // missing instrument
  });

  it("rejects invalid config (fail closed)", () => {
    const features = featuresFrom(fixtureCandles().slice(0, 10));
    expect(() => classifyFeatures(features, { volWindow: 0 })).toThrow();
    expect(() => classifyFeatures(features, { highVolRatio: 1 })).toThrow();
    expect(() => classifyFeatures(features, { lowVolRatio: 1.2 })).toThrow();
    expect(() => classifyFeatures(features, { trendAdx: 100 })).toThrow();
    expect(() => classifyFeatures(features, { rangeAdx: 30 })).toThrow(); // >= trendAdx
  });
});

describe("classifier determinism + no look-ahead (P04-02)", () => {
  it("same input -> identical assessments (determinism + idempotency)", () => {
    const features = featuresFrom(fixtureCandles());
    const a = classifyFeatures(features);
    const b = classifyFeatures(features);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("prefix truncation never changes earlier assessments (no look-ahead)", () => {
    const candles = fixtureCandles();
    const full = classifyFeatures(featuresFrom(candles));
    for (const cut of [80, 120, 160]) {
      const head = classifyFeatures(featuresFrom(candles.slice(0, cut)));
      for (let i = 0; i < cut; i += 1) {
        expect(head[i]).toEqual(full[i]);
      }
    }
  });

  it("appending future bars never changes earlier assessments (future-append invariance)", () => {
    const candles = fixtureCandles();
    const head = classifyFeatures(featuresFrom(candles.slice(0, 100)));
    const full = classifyFeatures(featuresFrom(candles));
    for (let i = 0; i < 100; i += 1) {
      expect(head[i]).toEqual(full[i]);
    }
  });
});