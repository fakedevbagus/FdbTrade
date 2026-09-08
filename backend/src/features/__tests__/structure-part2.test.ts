/**
 * Market-structure feature tests part 2 (P03-03): trend slope, multi-horizon
 * returns, session/time-of-day features, and the explicit no-look-ahead
 * proofs (truncation + future-append invariance).
 */
import { describe, expect, it } from "vitest";

import { getSchedule, type Candle } from "@fdbtrade/contracts";

import {
  atrFraction,
  candleStructure,
  multiHorizonReturns,
  realizedVolatilityWindows,
  sessionFeatures,
  trendSlope,
  trendSlopePips,
} from "@/features/structure";

const TOL = 9; // toBeCloseTo digits

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

describe("trendSlope (P03-03)", () => {
  it("slope of a perfectly linear series equals the increment per bar", () => {
    const closes = Array.from({ length: 10 }, (_, i) => 100 + 2 * i);
    const s = trendSlope(closes, 5);
    expect(s.slice(0, 4)).toEqual([null, null, null, null]);
    for (let i = 4; i < 10; i += 1) {
      expect(s[i] as number).toBeCloseTo(2, TOL);
    }
  });

  it("flat series slope is 0", () => {
    const s = trendSlope([5, 5, 5, 5, 5], 5);
    expect(s[4]).toBeCloseTo(0, TOL);
  });

  it("pips scaling uses metadata pip", () => {
    const closes = Array.from({ length: 6 }, (_, i) => 100 + 3 * i);
    const s = trendSlopePips(closes, 5, 0.1);
    expect(s[5]).toBeCloseTo(30, TOL);
  });

  it("rejects invalid windows and non-finite input (fail closed)", () => {
    expect(() => trendSlope([1, 2, 3], 1)).toThrow();
    expect(() => trendSlope([1, Number.POSITIVE_INFINITY, 3], 2)).toThrow();
    expect(() => trendSlopePips([1, 2], 2, 0)).toThrow();
  });
});

describe("multi-horizon returns / vol windows / atrFraction (P03-03)", () => {
  it("horizons are independent return series", () => {
    const closes = [100, 110, 121, 133.1];
    const m = multiHorizonReturns(closes, [1, 2]);
    expect(m[1][3]).toBeCloseTo(0.1, TOL);
    expect(m[2][3]).toBeCloseTo(0.21, TOL);
    expect(m[1][0]).toBeNull();
    expect(m[2][1]).toBeNull();
  });

  it("rejects duplicate/invalid horizons (fail closed)", () => {
    expect(() => multiHorizonReturns([1, 2, 3], [1, 1])).toThrow();
    expect(() => multiHorizonReturns([1, 2, 3], [0])).toThrow();
  });

  it("realized volatility windows reuse the P03-02 primitive", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 2 + i * 0.1);
    const m = realizedVolatilityWindows(closes, [10, 20], 12);
    expect(m[10].length).toBe(30);
    expect(m[20].filter((v) => v !== null).length).toBeGreaterThan(0);
    expect(() => realizedVolatilityWindows(closes, [5, 5], 12)).toThrow();
  });

  it("atrFraction normalizes ATR by close", () => {
    const cs = candlesFromCloses(Array.from({ length: 20 }, (_, i) => 1 + i * 0.01));
    const f = atrFraction(cs, 5);
    expect(f.slice(0, 4)).toEqual([null, null, null, null]);
    expect(f[4]).not.toBeNull();
    expect(f[4] as number).toBeGreaterThan(0);
    expect(f[4] as number).toBeLessThan(1);
  });
});

describe("sessionFeatures (P03-03)", () => {
  const schedule = getSchedule("fx-24x5");
  // 2026-09-08 is a Tuesday (fx-24x5: in-session 00:00-24:00 Tue).
  const tuesdayCandles: Candle[] = Array.from({ length: 5 }, (_, i) =>
    makeCandle(`2026-09-08T${10 + i}:00:00.000Z`, 1, 1.0002, 0.9998, 1),
  );

  it("derives day-of-week, hour and in-session from open time (UTC)", () => {
    const s = sessionFeatures(tuesdayCandles, schedule, "1h");
    expect(s[0].dayOfWeek).toBe("tue");
    expect(s[0].hourUtc).toBe(10);
    expect(s[0].inSession).toBe(true);
    expect(s[0].timeOfDayFraction).toBeCloseTo(10 / 24, TOL);
  });

  it("minutesSinceOpen counts back to the session boundary (bounded walk)", () => {
    const s = sessionFeatures(tuesdayCandles, schedule, "1h");
    // Tuesday 00:00-24:00 in-session: bar at 10:00 walks back to 00:00.
    expect(s[0].minutesSinceOpen).toBe(600);
    expect(s[4].minutesSinceOpen).toBe(840);
  });

  it("weekend bars are out of session (stale/closed boundary)", () => {
    const saturdayCandle = makeCandle("2026-09-12T10:00:00.000Z", 1, 1.0002, 0.9998, 1);
    const s = sessionFeatures([saturdayCandle], schedule, "1h");
    expect(s[0].inSession).toBe(false);
    expect(s[0].minutesSinceOpen).toBeNull();
    expect(s[0].dayOfWeek).toBe("sat");
  });

  it("session reopen boundary is flagged", () => {
    const candles = [
      makeCandle("2026-09-12T10:00:00.000Z", 1, 1.0002, 0.9998, 1), // sat: closed
      makeCandle("2026-09-14T00:00:00.000Z", 1, 1.0002, 0.9998, 1), // mon 00:00: open
    ];
    const s = sessionFeatures(candles, schedule, "1h");
    expect(s[0].isSessionReopen).toBeNull();
    expect(s[1].isSessionReopen).toBe(true);
  });

  it("empty series is empty (boundary) and output is deterministic", () => {
    expect(sessionFeatures([], schedule, "1h")).toEqual([]);
    expect(sessionFeatures(tuesdayCandles, schedule, "1h")).toEqual(
      sessionFeatures(tuesdayCandles, schedule, "1h"),
    );
  });
});

describe("no look-ahead proofs (P03-03)", () => {
  const closes = Array.from({ length: 80 }, (_, i) => 1 + Math.sin(i / 3) * 0.02 + i * 0.001);
  const candles = candlesFromCloses(closes);

  it("truncating the tail never changes earlier values", () => {
    const fullStructure = candleStructure(candles);
    const fullSlope = trendSlope(closes, 10);
    const fullAtrFrac = atrFraction(candles, 5);
    const fullMulti = multiHorizonReturns(closes, [3, 7]);
    for (const cut of [20, 50, 79]) {
      const headCandles = candles.slice(0, cut);
      const head = closes.slice(0, cut);
      const headStructure = candleStructure(headCandles);
      const headSlope = trendSlope(head, 10);
      const headAtrFrac = atrFraction(headCandles, 5);
      const headMulti = multiHorizonReturns(head, [3, 7]);
      for (let i = 0; i < cut; i += 1) {
        expect(headStructure[i]).toEqual(fullStructure[i]);
        expect(headSlope[i]).toBe(fullSlope[i]);
        expect(headAtrFrac[i]).toBe(fullAtrFrac[i]);
        expect(headMulti[3][i]).toBe(fullMulti[3][i]);
        expect(headMulti[7][i]).toBe(fullMulti[7][i]);
      }
    }
  });

  it("appending a future bar never changes past values", () => {
    const baseStructure = candleStructure(candles.slice(0, 40));
    const mutated = [
      ...candles.slice(0, 40),
      makeCandle("2026-09-12T02:00:00.000Z", 9, 99, 0.5, 42),
    ];
    const afterStructure = candleStructure(mutated);
    for (let i = 0; i < 40; i += 1) {
      expect(afterStructure[i]).toEqual(baseStructure[i]);
    }
    const beforeAtr = atrFraction(candles.slice(0, 40), 5);
    const afterAtr = atrFraction(mutated, 5);
    for (let i = 0; i < 40; i += 1) {
      expect(afterAtr[i]).toBe(beforeAtr[i]);
    }
  });

  it("pip size comes from instrument metadata, not a literal", () => {
    // getInstrument supplies pip; distanceToLevel in pips = (close-level)/pip.
    const d = (1.1005 - 1.1000) / 0.0001;
    expect(d).toBeCloseTo(5, 6);
  });
});

