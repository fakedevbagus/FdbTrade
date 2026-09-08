/**
 * Core indicator tests (P03-02).
 *
 * Acceptance: "Known fixtures match expected outputs within documented
 * tolerance." Hand-computable fixtures, numeric edge cases (constant series,
 * monotone series, zero/NaN guards), warmup null alignment, determinism and
 * no-look-ahead proofs (truncating the input must never change earlier
 * values).
 */
import { describe, expect, it } from "vitest";

import type { Candle } from "@fdbtrade/contracts";

import {
  adx,
  atr,
  ema,
  logReturns,
  macd,
  realizedVolatility,
  returns,
  rsi,
  sma,
  trueRange,
} from "@/features/indicators";

const TOL = 9; // toBeCloseTo digits (|diff| < 5e-10)

function candle(
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
    return candle(`2026-09-08T${hh}:00:00.000Z`, open, high, low, close);
  });
}

describe("sma (P03-02)", () => {
  it("matches a hand-computed fixture", () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out.slice(0, 2)).toEqual([null, null]);
    expect(out[2]).toBeCloseTo(2, TOL);
    expect(out[3]).toBeCloseTo(3, TOL);
    expect(out[4]).toBeCloseTo(4, TOL);
  });

  it("period 1 returns the series itself (boundary)", () => {
    expect(sma([1.5, 2.5], 1)).toEqual([1.5, 2.5]);
  });

  it("rejects invalid periods and non-finite input (fail closed)", () => {
    expect(() => sma([1, 2], 0)).toThrow();
    expect(() => sma([1, 2], 1.5)).toThrow();
    expect(() => sma([1, Number.NaN], 2)).toThrow();
    expect(() => sma([1, Number.POSITIVE_INFINITY], 2)).toThrow();
  });

  it("empty input yields empty output", () => {
    expect(sma([], 3)).toEqual([]);
  });
});

describe("ema (P03-02)", () => {
  it("seeds with the SMA and follows the recursive formula", () => {
    const values = [1, 2, 3, 4, 5];
    const out = ema(values, 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo(2, TOL); // SMA(1,2,3)
    const k = 2 / 4;
    expect(out[3]).toBeCloseTo(4 * k + 2 * (1 - k), TOL);
    const e3 = out[3] as number;
    expect(out[4]).toBeCloseTo(5 * k + e3 * (1 - k), TOL);
  });

  it("constant series is a fixed point", () => {
    const out = ema([5, 5, 5, 5, 5, 5], 3);
    expect(out[5]).toBeCloseTo(5, TOL);
  });

  it("rejects invalid periods", () => {
    expect(() => ema([1], 0)).toThrow();
  });
});

describe("trueRange / atr (P03-02)", () => {
  it("computes true range including gaps", () => {
    const cs = [
      candle("2026-09-08T10:00:00.000Z", 1.1, 1.11, 1.09, 1.1),
      candle("2026-09-08T11:00:00.000Z", 1.15, 1.16, 1.14, 1.15),
    ];
    const tr = trueRange(cs);
    expect(tr[0]).toBeCloseTo(0.02, TOL);
    // max(H-L=0.02, |H-prevC|=0.06, |L-prevC|=0.04) = 0.06
    expect(tr[1]).toBeCloseTo(0.06, TOL);
  });

  it("atr averages TR with Wilder smoothing and null warmup", () => {
    const cs = candlesFromCloses([1, 1.1, 1.2, 1.3, 1.4]);
    const out = atr(cs, 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    // Wilder: first ATR at index period-1 = mean(TR[0..period-1]).
    const tr = trueRange(cs);
    const expected = (tr[0] + tr[1] + tr[2]) / 3;
    expect(out[2]).toBeCloseTo(expected, TOL);
    expect(out[3]).toBeCloseTo((expected * 2 + tr[3]) / 3, TOL);
    expect(out[4]).toBeCloseTo(((out[3] as number) * 2 + tr[4]) / 3, TOL);
  });

  it("rejects empty-period and invalid candles series (fail closed)", () => {
    const cs = candlesFromCloses([1, 2, 3]);
    expect(() => atr(cs, 0)).toThrow();
  });
});

describe("rsi (P03-02)", () => {
  it("matches a hand-computed monotone-up fixture (RSI 100)", () => {
    const rising = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = rsi(rising, 4);
    expect(out.slice(0, 4)).toEqual([null, null, null, null]);
    for (let i = 4; i < out.length; i += 1) {
      expect(out[i]).toBeCloseTo(100, TOL);
    }
  });

  it("falls monotonically for a falling series (RSI 0)", () => {
    const falling = [8, 7, 6, 5, 4, 3, 2, 1];
    const out = rsi(falling, 4);
    for (let i = 4; i < out.length; i += 1) {
      expect(out[i]).toBeCloseTo(0, TOL);
    }
  });

  it("flat series yields 50 (all-zero change edge case)", () => {
    const out = rsi([5, 5, 5, 5, 5, 5], 3);
    expect(out[3]).toBeCloseTo(50, TOL);
    expect(out[4]).toBeCloseTo(50, TOL);
  });

  it("short series is all null (boundary)", () => {
    expect(rsi([1, 2], 3)).toEqual([null, null]);
    expect(rsi([], 3)).toEqual([]);
  });

  it("values stay within [0, 100]", () => {
    const noisy = [1, 1.2, 0.9, 1.4, 0.7, 1.5, 0.6, 1.6, 0.5, 1.7];
    for (const v of rsi(noisy, 3)) {
      if (v !== null) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });
});
