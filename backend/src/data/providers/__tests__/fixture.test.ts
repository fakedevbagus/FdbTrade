/**
 * Provider contract tests against the fixture provider (P02-02).
 *
 * Acceptance: "Provider contract tests pass against fixture provider;
 * unsupported capabilities are explicit." Covers happy path, malformed
 * input, boundary/empty ranges, weekend/session gaps, determinism
 * (idempotency of repeated fetches) and unsupported-capability errors.
 */
import { describe, expect, it } from "vitest";

import { candleSchema, deriveSpread, getInstrument, quoteSchema } from "@fdbtrade/contracts";

import { FixtureProvider } from "@/data/providers/fixture";

const provider = new FixtureProvider();

const MONDAY_START = "2026-09-07T00:00:00.000Z";
const MONDAY_END = "2026-09-08T00:00:00.000Z";
const SATURDAY_START = "2026-09-12T00:00:00.000Z";
const SUNDAY_END = "2026-09-14T00:00:00.000Z";

describe("FixtureProvider capabilities and health (P02-02)", () => {
  it("declares the full universe, all timeframes, synthetic, quote support", () => {
    const caps = provider.capabilities();
    expect(caps.providerId).toBe("fixture");
    expect(caps.instruments).toHaveLength(8);
    expect(caps.instruments).toEqual(
      expect.arrayContaining(["EURUSD", "USDJPY", "XAUUSD"]),
    );
    expect(caps.timeframes).toEqual(
      expect.arrayContaining(["5m", "15m", "1h", "4h", "1d"]),
    );
    expect(caps.supportsQuotes).toBe(true);
    expect(caps.isSynthetic).toBe(true);
  });

  it("reports healthy with sanitized detail", async () => {
    const health = await provider.health();
    expect(health.status).toBe("healthy");
    expect(health.providerId).toBe("fixture");
    expect(health.detail).not.toMatch(/password|secret|token|credential/i);
  });
});

describe("FixtureProvider.getHistoricalCandles (P02-02)", () => {
  it("returns valid candles for a weekday range (happy path)", async () => {
    const candles = await provider.getHistoricalCandles({
      instrument: "EURUSD",
      timeframe: "1h",
      startUtc: MONDAY_START,
      endUtc: MONDAY_END,
    });
    expect(candles.length).toBe(24); // Monday is a 24h fx day
    for (const candle of candles) {
      expect(candleSchema.safeParse(candle).success).toBe(true);
    }
    for (let i = 1; i < candles.length; i += 1) {
      expect(Date.parse(candles[i].timestamp)).toBeGreaterThan(
        Date.parse(candles[i - 1].timestamp),
      );
    }
  });

  it("is deterministic: identical requests (even fresh instances) return identical data", async () => {
    const request = {
      instrument: "GBPUSD",
      timeframe: "15m" as const,
      startUtc: MONDAY_START,
      endUtc: "2026-09-07T06:00:00.000Z",
    };
    const a = await provider.getHistoricalCandles(request);
    const b = await provider.getHistoricalCandles(request);
    const fresh = await new FixtureProvider().getHistoricalCandles(request);
    expect(a).toEqual(b);
    expect(fresh).toEqual(a);
  });

  it("returns no weekend candles (session-aware, no invented data)", async () => {
    const candles = await provider.getHistoricalCandles({
      instrument: "EURUSD",
      timeframe: "1h",
      startUtc: SATURDAY_START,
      endUtc: SUNDAY_END,
    });
    expect(candles).toEqual([]);
  });

  it("respects metals maintenance closure (01:00 UTC daily break)", async () => {
    const candles = await provider.getHistoricalCandles({
      instrument: "XAUUSD",
      timeframe: "1h",
      startUtc: MONDAY_START,
      endUtc: MONDAY_END,
    });
    // Monday metals window: 01:00 -> next 01:00 (22:00 close + maintenance).
    // Hourly bars whose open AND close are inside: 01:00..22:00 = 22 bars
    // (the 23:00 bar closes Tue 00:00, still inside the maintenance break).
    expect(candles.length).toBe(22);
    expect(candles[0].timestamp).toBe("2026-09-07T01:00:00.000Z");
    expect(candles[candles.length - 1].timestamp).toBe("2026-09-07T22:00:00.000Z");
  });

  it("handles boundary ranges: a range containing only a bar's open instant returns that bar", async () => {
    const candles = await provider.getHistoricalCandles({
      instrument: "EURUSD",
      timeframe: "1h",
      startUtc: MONDAY_START,
      endUtc: "2026-09-07T00:00:00.001Z",
    });
    // Open-time-in-range semantics: the 00:00 bar's OPEN falls inside the
    // 1ms window, so exactly that bar is returned.
    expect(candles).toHaveLength(1);
    expect(candles[0].timestamp).toBe(MONDAY_START);
  });

  it("produces prices near the anchor base (no runaway synthesis)", async () => {
    const candles = await provider.getHistoricalCandles({
      instrument: "EURUSD",
      timeframe: "1h",
      startUtc: MONDAY_START,
      endUtc: MONDAY_END,
    });
    for (const candle of candles) {
      expect(Math.abs(candle.close - 1.1)).toBeLessThan(0.05);
    }
  });

  it("rejects malformed requests (validation at the boundary)", async () => {
    const cases: unknown[] = [
      { instrument: "EURUSD", timeframe: "1h", startUtc: MONDAY_END, endUtc: MONDAY_START },
      { instrument: "EURUSD", timeframe: "7m", startUtc: MONDAY_START, endUtc: MONDAY_END },
      { instrument: "NOPE", timeframe: "1h", startUtc: MONDAY_START, endUtc: MONDAY_END },
      { instrument: "EURUSD", timeframe: "1h", startUtc: "2026-09-07", endUtc: MONDAY_END },
      { instrument: "EURUSD", timeframe: "1h" },
    ];
    for (const bad of cases) {
      await expect(
        provider.getHistoricalCandles(bad as never),
      ).rejects.toThrow();
    }
  });

  it("throws explicit UNSUPPORTED_INSTRUMENT for unmapped instruments", async () => {
    await expect(
      provider.getHistoricalCandles({
        instrument: "ZZZUSD",
        timeframe: "1h",
        startUtc: MONDAY_START,
        endUtc: MONDAY_END,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INSTRUMENT" });
  });
});

describe("FixtureProvider.getQuotes (P02-02)", () => {
  it("returns one valid two-sided quote per instrument", async () => {
    const quotes = await provider.getQuotes({
      instruments: ["EURUSD", "USDJPY", "XAUUSD"],
      atUtc: "2026-09-09T12:00:00.000Z",
    });
    expect(quotes).toHaveLength(3);
    for (const quote of quotes) {
      expect(quoteSchema.safeParse(quote).success).toBe(true);
      expect(quote.isSynthetic).toBe(true);
      expect(quote.ask).toBeGreaterThanOrEqual(quote.bid);
    }
  });

  it("spreads are sane in pips (metadata-driven)", async () => {
    const [eur] = await provider.getQuotes({
      instruments: ["EURUSD"],
      atUtc: "2026-09-09T12:00:00.000Z",
    });
    const spread = deriveSpread(eur, getInstrument("EURUSD").precision);
    expect(spread.spreadPips).toBeGreaterThan(0);
    expect(spread.spreadPips).toBeLessThan(10);
  });

  it("is deterministic across calls and instances", async () => {
    const request = { instruments: ["EURUSD"], atUtc: "2026-09-09T12:34:56.789Z" };
    const a = await provider.getQuotes(request);
    const b = await new FixtureProvider().getQuotes(request);
    expect(a).toEqual(b);
  });

  it("rejects malformed/empty requests and unknown instruments", async () => {
    await expect(
      provider.getQuotes({ instruments: [], atUtc: MONDAY_START }),
    ).rejects.toThrow();
    await expect(
      provider.getQuotes({ instruments: ["ZZZUSD"], atUtc: MONDAY_START }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INSTRUMENT" });
    await expect(
      provider.getQuotes({ instruments: ["EURUSD"], atUtc: "not-a-time" } as never),
    ).rejects.toThrow();
  });
});
