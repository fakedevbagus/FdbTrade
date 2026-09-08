/**
 * Normalizer + validator tests (P02-03).
 *
 * Acceptance: "Bad fixture cases are rejected/quarantined with reason codes;
 * valid fixtures normalize deterministically." Covers: symbol mapping,
 * timestamp forms (offset/epoch/naive), precision rounding, misalignment,
 * duplicates, out-of-order, session gaps vs closure gaps, impossible OHLC,
 * crossed/stale/future quotes, determinism, and the no-repair invariant.
 */
import { describe, expect, it } from "vitest";

import { candleSchema, type Candle, type Quote } from "@fdbtrade/contracts";

import {
  normalizePrice,
  normalizeProviderCandle,
  normalizeProviderQuote,
  normalizeTimestamp,
} from "@/data/quality/normalizer";
import { validateCandleSeries, validateQuotes } from "@/data/quality/validator";

const PROVIDER = "fixture";

function eurBar(timestamp: string, open = 1.1): Record<string, unknown> {
  return {
    providerSymbol: "EURUSD",
    timeframe: "1h",
    timestamp,
    open,
    high: open + 0.001,
    low: open - 0.001,
    close: open + 0.0005,
    volume: null,
  };
}

function canonicalCandle(timestamp: string): Candle {
  return {
    instrument: "EURUSD",
    timeframe: "1h",
    timestamp,
    open: 1.1,
    high: 1.101,
    low: 1.099,
    close: 1.1005,
    volume: null,
  };
}

describe("normalizeTimestamp (P02-03)", () => {
  it("accepts Z, offset and epoch forms and converts to canonical UTC", () => {
    expect(normalizeTimestamp("2026-09-08T10:00:00.000Z")).toBe(
      "2026-09-08T10:00:00.000Z",
    );
    expect(normalizeTimestamp("2026-09-08T12:00:00.000+02:00")).toBe(
      "2026-09-08T10:00:00.000Z",
    );
    // Epoch seconds for 2026-04-09T00:00:00Z (verified via date -u).
    expect(normalizeTimestamp(1_775_692_800_000)).toBe("2026-04-09T00:00:00.000Z");
    expect(normalizeTimestamp(1_775_692_800)).toBe("2026-04-09T00:00:00.000Z");
    // Epoch seconds for 2026-09-08T10:00:00Z (verified via date -u).
    expect(normalizeTimestamp(1_788_861_600)).toBe("2026-09-08T10:00:00.000Z");
  });

  it("rejects naive timestamps (no silent UTC assumption)", () => {
    expect(() => normalizeTimestamp("2026-09-08T10:00:00.000")).toThrow(/naive/);
    expect(() => normalizeTimestamp("2026-09-08")).toThrow();
    expect(() => normalizeTimestamp("garbage")).toThrow();
    expect(() => normalizeTimestamp(Number.NaN)).toThrow();
  });

  it("is deterministic for identical inputs", () => {
    expect(normalizeTimestamp("2026-09-08T12:00:00+05:30")).toBe(
      normalizeTimestamp("2026-09-08T12:00:00+05:30"),
    );
  });
});

describe("normalizeProviderCandle (P02-03)", () => {
  it("maps provider symbol to canonical id and normalizes prices to digits", () => {
    const result = normalizeProviderCandle(
      PROVIDER,
      {
        providerSymbol: "EURUSD",
        timeframe: "1h",
        timestamp: "2026-09-08T12:00:00.000+02:00", // -> 10:00Z, aligned
        open: 1.10851234,
        high: 1.10861234,
        low: 1.10841234,
        close: 1.10851234,
        volume: null,
      },
      0,
    );
    expect(result.value).not.toBeNull();
    expect(result.value!.instrument).toBe("EURUSD");
    expect(result.value!.timestamp).toBe("2026-09-08T10:00:00.000Z");
    expect(result.value!.open).toBeCloseTo(1.10851, 10);
    expect(candleSchema.safeParse(result.value!).success).toBe(true);
  });

  it("quarantines unknown provider symbols with reason code", () => {
    const result = normalizeProviderCandle(
      PROVIDER,
      { ...eurBar("2026-09-08T10:00:00.000Z"), providerSymbol: "NOTMAPPED" },
      4,
    );
    expect(result.value).toBeNull();
    expect(result.reason?.reason).toBe("UNKNOWN_PROVIDER_SYMBOL");
  });

  it("quarantines naive timestamps (INVALID_TIMESTAMP)", () => {
    const result = normalizeProviderCandle(
      PROVIDER,
      eurBar("2026-09-08T10:00:00.000"),
      1,
    );
    expect(result.value).toBeNull();
    expect(result.reason?.reason).toBe("INVALID_TIMESTAMP");
  });

  it("quarantines misaligned bar opens (never shifts them)", () => {
    const result = normalizeProviderCandle(
      PROVIDER,
      eurBar("2026-09-08T10:03:00.000Z"),
      2,
    );
    expect(result.value).toBeNull();
    expect(result.reason?.reason).toBe("MISALIGNED_TIMESTAMP");
  });

  it("quarantines impossible OHLC", () => {
    const result = normalizeProviderCandle(
      PROVIDER,
      {
        providerSymbol: "EURUSD",
        timeframe: "1h",
        timestamp: "2026-09-08T10:00:00.000Z",
        open: 1.1,
        high: 1.09,
        low: 1.08,
        close: 1.11,
        volume: null,
      },
      5,
    );
    expect(result.value).toBeNull();
    expect(result.reason?.reason).toBe("IMPOSSIBLE_OHLC");
  });

  it("rejects malformed payloads (schema failure)", () => {
    const result = normalizeProviderCandle(PROVIDER, { nonsense: true }, 6);
    expect(result.value).toBeNull();
    expect(result.reason).toBeDefined();
  });

  it("is deterministic: same input twice, same result", () => {
    const raw = eurBar("2026-09-08T10:00:00.000Z");
    expect(normalizeProviderCandle(PROVIDER, raw, 0)).toEqual(
      normalizeProviderCandle(PROVIDER, raw, 0),
    );
  });
});

describe("normalizeProviderQuote (P02-03)", () => {
  it("normalizes a valid quote deterministically (offset -> UTC)", () => {
    const quote = normalizeProviderQuote(
      PROVIDER,
      true,
      {
        providerSymbol: "USDJPY",
        timestamp: "2026-09-08T12:00:00+09:00", // -> 03:00Z
        bid: 155.121123,
        ask: 155.129123,
      },
      0,
    );
    expect(quote.value).not.toBeNull();
    expect(quote.value!.timestamp).toBe("2026-09-08T03:00:00.000Z");
    expect(quote.value!.bid).toBeCloseTo(155.121, 10);
    expect(quote.value!.isSynthetic).toBe(true);
  });

  it("quarantines crossed quotes (ask < bid)", () => {
    const quote = normalizeProviderQuote(
      PROVIDER,
      true,
      {
        providerSymbol: "EURUSD",
        timestamp: "2026-09-08T10:00:00.000Z",
        bid: 1.1087,
        ask: 1.1085,
      },
      0,
    );
    expect(quote.value).toBeNull();
    expect(quote.reason?.reason).toBe("CROSSED_QUOTE");
  });

  it("quarantines unmapped symbols", () => {
    const quote = normalizeProviderQuote(
      PROVIDER,
      true,
      { providerSymbol: "ZZZ", timestamp: "2026-09-08T10:00:00.000Z", bid: 1, ask: 2 },
      0,
    );
    expect(quote.value).toBeNull();
    expect(quote.reason?.reason).toBe("UNKNOWN_PROVIDER_SYMBOL");
  });
});

describe("validateCandleSeries (P02-03)", () => {
  it("accepts a clean contiguous weekday series (happy path)", () => {
    const series = [
      canonicalCandle("2026-09-08T10:00:00.000Z"),
      canonicalCandle("2026-09-08T11:00:00.000Z"),
      canonicalCandle("2026-09-08T12:00:00.000Z"),
    ];
    const report = validateCandleSeries(series);
    expect(report.accepted).toEqual([0, 1, 2]);
    expect(report.quarantined).toEqual([]);
    expect(report.gaps).toEqual([]);
  });

  it("quarantines duplicates (first occurrence wins)", () => {
    const series = [
      canonicalCandle("2026-09-08T10:00:00.000Z"),
      canonicalCandle("2026-09-08T10:00:00.000Z"),
      canonicalCandle("2026-09-08T11:00:00.000Z"),
    ];
    const report = validateCandleSeries(series);
    expect(report.accepted).toEqual([0, 2]);
    expect(report.quarantined).toHaveLength(1);
    expect(report.quarantined[0]).toMatchObject({
      index: 1,
      reason: "DUPLICATE_TIMESTAMP",
    });
  });

  it("quarantines out-of-order bars", () => {
    const series = [
      canonicalCandle("2026-09-08T11:00:00.000Z"),
      canonicalCandle("2026-09-08T10:00:00.000Z"),
    ];
    const report = validateCandleSeries(series);
    expect(report.accepted).toEqual([0]);
    expect(report.quarantined[0]).toMatchObject({ index: 1, reason: "OUT_OF_ORDER" });
  });

  it("reports SESSION_GAP for missing bars inside open sessions", () => {
    const series = [
      canonicalCandle("2026-09-08T10:00:00.000Z"),
      canonicalCandle("2026-09-08T13:00:00.000Z"),
    ];
    const report = validateCandleSeries(series);
    expect(report.accepted).toEqual([0, 1]);
    expect(report.gaps.map((g) => g.expectedOpenUtc)).toEqual([
      "2026-09-08T11:00:00.000Z",
      "2026-09-08T12:00:00.000Z",
    ]);
  });

  it("does NOT report gaps across the weekend closure (expected closure)", () => {
    const series = [
      canonicalCandle("2026-09-11T21:00:00.000Z"),
      canonicalCandle("2026-09-14T00:00:00.000Z"),
    ];
    const report = validateCandleSeries(series);
    expect(report.gaps).toEqual([]);
  });

  it("reports a gap for a missing bar fully inside open hours", () => {
    // Friday 19:00 -> 21:00 with 20:00 missing: the 20:00 bar's open and
    // close (21:00) are both inside the fx session (open until 22:00).
    const series = [
      canonicalCandle("2026-09-11T19:00:00.000Z"),
      canonicalCandle("2026-09-11T21:00:00.000Z"),
    ];
    const report = validateCandleSeries(series);
    expect(report.gaps.map((g) => g.expectedOpenUtc)).toEqual([
      "2026-09-11T20:00:00.000Z",
    ]);
  });

  it("handles empty series (boundary)", () => {
    const report = validateCandleSeries([]);
    expect(report.accepted).toEqual([]);
    expect(report.quarantined).toEqual([]);
    expect(report.gaps).toEqual([]);
  });

  it("quarantines impossible OHLC (defense in depth)", () => {
    const series: Candle[] = [
      {
        instrument: "EURUSD",
        timeframe: "1h",
        timestamp: "2026-09-08T10:00:00.000Z",
        open: 1.1,
        high: 1.09,
        low: 1.08,
        close: 1.11,
        volume: null,
      },
    ];
    const report = validateCandleSeries(series);
    expect(report.accepted).toEqual([]);
    expect(report.quarantined[0].reason).toBe("IMPOSSIBLE_OHLC");
  });

  it("rejects mixed series with an explicit error (caller bug)", () => {
    const series = [
      canonicalCandle("2026-09-08T10:00:00.000Z"),
      { ...canonicalCandle("2026-09-08T11:00:00.000Z"), instrument: "GBPUSD" },
    ];
    expect(() => validateCandleSeries(series)).toThrow(/mixed series/);
  });

  it("is idempotent: validating twice yields identical reports", () => {
    const series = [
      canonicalCandle("2026-09-08T10:00:00.000Z"),
      canonicalCandle("2026-09-08T10:00:00.000Z"),
      canonicalCandle("2026-09-08T13:00:00.000Z"),
    ];
    expect(validateCandleSeries(series)).toEqual(validateCandleSeries(series));
  });
});

describe("validateQuotes (P02-03)", () => {
  const asOf = "2026-09-08T10:00:10.000Z";

  function quote(timestamp: string): Quote {
    return {
      instrument: "EURUSD",
      timestamp,
      bid: 1.1085,
      ask: 1.1087,
      isSynthetic: true,
    };
  }

  it("accepts fresh quotes within maxAge", () => {
    const report = validateQuotes([quote("2026-09-08T10:00:05.000Z")], asOf, 30_000);
    expect(report.accepted).toEqual([0]);
    expect(report.quarantined).toEqual([]);
  });

  it("quarantines stale quotes past maxAge", () => {
    const report = validateQuotes([quote("2026-09-08T09:00:00.000Z")], asOf, 30_000);
    expect(report.accepted).toEqual([]);
    expect(report.quarantined[0].reason).toBe("STALE_QUOTE");
  });

  it("quarantines future-dated quotes (clock skew / look-ahead risk)", () => {
    const report = validateQuotes([quote("2026-09-08T10:00:11.000Z")], asOf, 30_000);
    expect(report.accepted).toEqual([]);
    expect(report.quarantined[0].reason).toBe("STALE_QUOTE");
  });

  it("quarantines crossed quotes (defense in depth)", () => {
    const crossed: Quote = { ...quote(asOf), bid: 1.1087, ask: 1.1085 };
    const report = validateQuotes([crossed], asOf, 30_000);
    expect(report.quarantined[0].reason).toBe("CROSSED_QUOTE");
  });

  it("handles the empty list (boundary)", () => {
    const report = validateQuotes([], asOf, 30_000);
    expect(report.accepted).toEqual([]);
    expect(report.quarantined).toEqual([]);
  });
});


