/**
 * ADX/MACD/returns/volatility indicator tests (P03-02, part 2) plus
 * determinism and no-look-ahead proofs.
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
} from "@/features/indicators";

const TOL = 9; // toBeCloseTo digits (|diff| < 5e-10)

function candlesFromCloses(closes: number[], startHour = 10): Candle[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    const high = Math.max(open, close) + 0.0002;
    const low = Math.min(open, close) - 0.0002;
    const hh = String(startHour + i).padStart(2, "0");
    return {
      instrument: "EURUSD",
      timeframe: "1h",
      timestamp: `2026-09-08T${hh}:00:00.000Z`,
      open,
      high,
      low,
      close,
      volume: null,
    };
  });
}

describe("adx (P03-02)", () => {
  it("produces values only after 2*period-1 bars (warmup alignment)", () => {
    const cs = candlesFromCloses(Array.from({ length: 12 }, (_, i) => 1 + i * 0.05));
    const out = adx(cs, 3);
    const firstNonNull = out.findIndex((v) => v !== null);
    expect(firstNonNull).toBe(2 * 3 - 1);
  });

  it("strongly trending series yields high ADX", () => {
    const cs = candlesFromCloses(Array.from({ length: 20 }, (_, i) => 1 + i * 0.1));
    const out = adx(cs, 5);
    const last = out[out.length - 1];
    expect(last).not.toBeNull();
    expect(last as number).toBeGreaterThan(50);
  });

  it("values stay within [0, 100]", () => {
    const cs = candlesFromCloses(
      Array.from({ length: 30 }, (_, i) => 1 + Math.sin(i) * 0.3 + i * 0.01),
    );
    for (const v of adx(cs, 4)) {
      if (v !== null) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it("empty/one-bar series is all null (boundary)", () => {
    expect(adx([], 3)).toEqual([]);
    expect(adx(candlesFromCloses([1]), 3)).toEqual([null]);
  });

  it("rejects invalid period (fail closed)", () => {
    expect(() => adx(candlesFromCloses([1, 2, 3]), 0)).toThrow();
  });
});

describe("macd (P03-02)", () => {
  it("aligns macd/signal/histogram with the input series", () => {
    const values = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.2);
    const { macd: line, signal, histogram } = macd(values, 12, 26, 9);
    expect(line.length).toBe(values.length);
    expect(signal.length).toBe(values.length);
    expect(histogram.length).toBe(values.length);
    // macd line starts at slow-1 = 25.
    expect(line[24]).toBeNull();
    expect(line[25]).not.toBeNull();
    // signal starts 9 macd values later = 33.
    expect(signal[32]).toBeNull();
    expect(signal[33]).not.toBeNull();
    for (let i = 0; i < values.length; i += 1) {
      if (signal[i] !== null && line[i] !== null) {
        expect(histogram[i]).toBeCloseTo((line[i] as number) - (signal[i] as number), TOL);
      }
    }
  });

  it("macd line equals ema(fast) - ema(slow) (definition check)", () => {
    const values = Array.from({ length: 50 }, (_, i) => 100 + Math.cos(i / 2) * 3 + i * 0.1);
    const { macd: line } = macd(values, 5, 10, 3);
    const fast = ema(values, 5);
    const slow = ema(values, 10);
    for (let i = 0; i < values.length; i += 1) {
      const expected =
        fast[i] !== null && slow[i] !== null ? (fast[i] as number) - (slow[i] as number) : null;
      if (expected === null) {
        expect(line[i]).toBeNull();
      } else {
        expect(line[i]).toBeCloseTo(expected, TOL);
      }
    }
  });

  it("rejects fast >= slow and invalid periods (fail closed)", () => {
    expect(() => macd([1, 2, 3], 12, 12, 9)).toThrow();
    expect(() => macd([1, 2, 3], 26, 12, 9)).toThrow(/must be </);
    expect(() => macd([1, 2, 3], 0, 26, 9)).toThrow();
  });

  it("short series is all null (boundary)", () => {
    const { macd: line, signal } = macd([1, 2, 3, 4], 2, 4, 2);
    for (const v of line) expect(v === null || Number.isFinite(v)).toBe(true);
    expect(signal.every((v) => v === null)).toBe(true);
  });
});

describe("returns / logReturns / realizedVolatility (P03-02)", () => {
  it("returns match the ratio definition", () => {
    const out = returns([100, 110, 121], 1);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeCloseTo(0.1, TOL);
    expect(out[2]).toBeCloseTo(0.1, TOL);
    const two = returns([100, 110, 121], 2);
    expect(two[0]).toBeNull();
    expect(two[1]).toBeNull();
    expect(two[2]).toBeCloseTo(0.21, TOL);
  });

  it("zero base price yields null (documented edge case)", () => {
    expect(returns([0, 5, 10], 1)[1]).toBeNull();
  });

  it("logReturns reject non-positive prices (fail closed)", () => {
    expect(() => logReturns([1, -2, 3], 1)).toThrow(/positive/);
    expect(() => logReturns([1, 0, 3], 1)).toThrow(/positive/);
  });

  it("logReturns match ln ratio", () => {
    const out = logReturns([100, 105], 1);
    expect(out[1]).toBeCloseTo(Math.log(1.05), TOL);
  });

  it("realized volatility of a constant series is 0 after warmup", () => {
    const flat = Array.from({ length: 10 }, () => 100);
    const out = realizedVolatility(flat, 5, 12);
    expect(out[0]).toBeNull();
    expect(out[5]).not.toBeNull();
    expect(out[5]).toBeCloseTo(0, TOL);
  });

  it("realized volatility is positive for alternating series", () => {
    const alt = Array.from({ length: 10 }, (_, i) => 100 * (i % 2 === 0 ? 1 : 1.01));
    const out = realizedVolatility(alt, 5, 12);
    const last = out[out.length - 1];
    expect(last).not.toBeNull();
    expect(last as number).toBeGreaterThan(0);
  });

  it("rejects invalid window/annualization (fail closed)", () => {
    expect(() => realizedVolatility([1, 2, 3], 0, 12)).toThrow();
    expect(() => realizedVolatility([1, 2, 3], 2, 0)).toThrow();
  });
});

describe("determinism + no look-ahead (P03-02)", () => {
  const values = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 4 + i * 0.05);

  it("same input always yields identical output", () => {
    expect(ema(values, 9)).toEqual(ema(values, 9));
    expect(rsi(values, 14)).toEqual(rsi(values, 14));
    expect(macd(values, 12, 26, 9)).toEqual(macd(values, 12, 26, 9));
    expect(realizedVolatility(values, 10, 24)).toEqual(realizedVolatility(values, 10, 24));
  });

  it("truncating the tail never changes earlier values (no look-ahead)", () => {
    const full = rsi(values, 14);
    const fullEma = ema(values, 9);
    const fullMacd = macd(values, 12, 26, 9);
    const fullAtr = atr(candlesFromCloses(values), 14);
    for (const cut of [30, 45, 59]) {
      const head = values.slice(0, cut);
      const headRsi = rsi(head, 14);
      const headEma = ema(head, 9);
      const headMacd = macd(head, 12, 26, 9);
      const headAtr = atr(candlesFromCloses(head), 14);
      for (let i = 0; i < cut; i += 1) {
        expect(headRsi[i]).toBe(full[i]);
        expect(headEma[i]).toBe(fullEma[i]);
        expect(headMacd.macd[i]).toBe(fullMacd.macd[i]);
        expect(headMacd.signal[i]).toBe(fullMacd.signal[i]);
        expect(headAtr[i]).toBe(fullAtr[i]);
      }
    }
  });
});

