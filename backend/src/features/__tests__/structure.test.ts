/**
 * Market-structure feature tests (P03-03).
 *
 * Acceptance: "Features are computed without future bars; tests explicitly
 * prove no look-ahead." Hand fixtures + tail-truncation proofs (values at
 * bar i computed on a prefix must equal the values from the full series).
 */
import { describe, expect, it } from "vitest";

import { getInstrument, type Candle } from "@fdbtrade/contracts";

import {
  atrFraction,
  candleStructure,
  distanceToLevel,
  distanceToPriorRange,
  multiHorizonReturns,
  realizedVolatilityWindows,
  rollingPriorHigh,
  rollingPriorLow,
  trendSlope,
  trendSlopePips,
} from "@/features/structure";

const TOL = 9; // toBeCloseTo digits

const PIP = getInstrument("EURUSD").precision.pip; // metadata, not literal

function makeCandle(
  timestamp: string,
  open: number,
  high: number,
  low: number,
  close: number,
): Candle {
  return { instrument: "EURUSD", timeframe: "1h", timestamp, open, high, low, close, volume: null };
}

function candlesFromCloses(closes: number[], startHour = 10): Candle[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    const high = Math.max(open, close) + 0.0002;
    const low = Math.min(open, close) - 0.0002;
    const hh = String(startHour + i).padStart(2, "0");
    return makeCandle(`2026-09-08T${hh}:00:00.000Z`, open, high, low, close);
  });
}

describe("candleStructure (P03-03)", () => {
  it("computes body/ratio/wick/direction fixtures", () => {
    const cs = [
      makeCandle("2026-09-08T10:00:00.000Z", 1.1, 1.15, 1.08, 1.12),
      makeCandle("2026-09-08T11:00:00.000Z", 1.12, 1.16, 1.10, 1.11),
    ];
    const s = candleStructure(cs);
    expect(s[0].direction).toBe("bull");
    expect(s[0].bodyAbs).toBeCloseTo(0.02, TOL);
    expect(s[0].rangeAbs).toBeCloseTo(0.07, TOL);
    expect(s[0].bodyRatio).toBeCloseTo(0.02 / 0.07, TOL);
    expect(s[0].upperWickRatio).toBeCloseTo((1.15 - 1.12) / 0.07, TOL);
    expect(s[0].isInsideBar).toBeNull(); // first bar has no previous
    expect(s[1].direction).toBe("bear");
  });

  it("upper wick uses max(open,close) — never negative", () => {
    const cs = [makeCandle("2026-09-08T10:00:00.000Z", 1.1, 1.13, 1.09, 1.12)];
    const s = candleStructure(cs);
    expect(s[0].upperWickRatio).toBeCloseTo((1.13 - Math.max(1.1, 1.12)) / 0.04, TOL);
    expect(s[0].lowerWickRatio).toBeCloseTo((Math.min(1.1, 1.12) - 1.09) / 0.04, TOL);
  });

  it("zero-range bar yields null ratios (boundary)", () => {
    const cs = [makeCandle("2026-09-08T10:00:00.000Z", 1.1, 1.1, 1.1, 1.1)];
    const s = candleStructure(cs);
    expect(s[0].bodyRatio).toBeNull();
    expect(s[0].upperWickRatio).toBeNull();
    expect(s[0].lowerWickRatio).toBeNull();
    expect(s[0].direction).toBe("flat");
  });

  it("inside/outside bar classification uses only the previous bar", () => {
    const cs = [
      makeCandle("2026-09-08T10:00:00.000Z", 1.1, 1.2, 1.0, 1.15),
      makeCandle("2026-09-08T11:00:00.000Z", 1.15, 1.18, 1.05, 1.1),
      makeCandle("2026-09-08T12:00:00.000Z", 1.1, 1.25, 0.95, 1.2),
    ];
    const s = candleStructure(cs);
    expect(s[1].isInsideBar).toBe(true);
    expect(s[1].isOutsideBar).toBe(false);
    expect(s[2].isOutsideBar).toBe(true);
    expect(s[2].isInsideBar).toBe(false);
  });

  it("empty series is empty (boundary)", () => {
    expect(candleStructure([])).toEqual([]);
  });
});

describe("distanceToLevel / distanceToPriorRange (P03-03)", () => {
  it("signed distance in pips (metadata pip size)", () => {
    // EURUSD pip = 0.0001 -> 0.0005 price distance = 5 pips.
    const d = distanceToLevel([1.1005, 1.0995], 1.1, PIP);
    expect(d[0]).toBeCloseTo(5, TOL);
    expect(d[1]).toBeCloseTo(-5, TOL);
  });

  it("rejects invalid pip and non-finite closes (fail closed)", () => {
    expect(() => distanceToLevel([1], 1, 0)).toThrow();
    expect(() => distanceToLevel([Number.NaN], 1, PIP)).toThrow();
  });

  it("prior high/low EXCLUDE the current bar (no self-lookahead)", () => {
    const cs = candlesFromCloses([1, 1.1, 1.2, 1.15]);
    const highs = rollingPriorHigh(cs, 2);
    expect(highs[0]).toBeNull();
    expect(highs[1]).toBeNull();
    expect(highs[2]).toBeCloseTo(Math.max(cs[0].high, cs[1].high), TOL);
    const lows = rollingPriorLow(cs, 2);
    expect(lows[3]).toBeCloseTo(Math.min(cs[1].low, cs[2].low), TOL);
    const { toHigh, toLow } = distanceToPriorRange(cs, 2, PIP);
    expect(toHigh[2]).toBeCloseTo((cs[2].close - highs[2]!) / PIP, TOL);
    expect(toLow[2]).toBeCloseTo((cs[2].close - lows[2]!) / PIP, TOL);
  });

  it("rejects invalid windows (fail closed)", () => {
    expect(() => rollingPriorHigh([], 0)).toThrow();
    expect(() => rollingPriorLow([], 1.5)).toThrow();
  });
});
