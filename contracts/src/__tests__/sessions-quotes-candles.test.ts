/**
 * Session, quote/spread, candle and registry tests (P02-01).
 */
import { describe, expect, it } from "vitest";

import {
  deriveSpread,
  getInstrument,
  getSchedule,
  INSTRUMENTS,
  isCandleAligned,
  isInstantInSchedule,
  isKnownInstrument,
  quoteSchema,
  sessionCatalogSchema,
  candleSchema,
  validateRegistryIntegrity,
} from "@/index";

const EURUSD = getInstrument("EURUSD");

describe("session schedules (P02-01)", () => {
  it("timezone is locked to UTC and schedules live in data", () => {
    const fx = getSchedule(EURUSD.sessionsRef);
    expect(fx.timezone).toBe("UTC");
    expect(fx.windows).toHaveLength(5); // mon..fri only
  });

  it("fx-24x5: open weekdays, closed weekends and Friday 22:00 UTC onward", () => {
    const fx = getSchedule("fx-24x5");
    expect(isInstantInSchedule("2026-09-07T00:00:00.000Z", fx)).toBe(true); // Mon 00:00
    expect(isInstantInSchedule("2026-09-09T12:34:56.000Z", fx)).toBe(true); // Wed midday
    expect(isInstantInSchedule("2026-09-11T21:59:59.000Z", fx)).toBe(true); // Fri 21:59
    expect(isInstantInSchedule("2026-09-11T22:00:00.000Z", fx)).toBe(false); // Fri 22:00
    expect(isInstantInSchedule("2026-09-12T10:00:00.000Z", fx)).toBe(false); // Sat
    expect(isInstantInSchedule("2026-09-13T23:00:00.000Z", fx)).toBe(false); // Sun
  });

  it("metals-23x5: closed before 01:00 UTC, open during the day", () => {
    const metals = getSchedule("metals-23x5");
    expect(isInstantInSchedule("2026-09-08T00:59:59.000Z", metals)).toBe(false);
    expect(isInstantInSchedule("2026-09-08T01:00:00.000Z", metals)).toBe(true);
    expect(isInstantInSchedule("2026-09-08T23:30:00.000Z", metals)).toBe(true);
    expect(isInstantInSchedule("2026-09-11T21:00:00.000Z", metals)).toBe(false);
  });

  it("excludes instants inside a declared break", () => {
    const schedule = sessionCatalogSchema.parse({
      version: "1.0.0",
      updatedAtUtc: "2026-09-08T00:00:00.000Z",
      schedules: [
        {
          id: "with-break",
          description: "test schedule",
          timezone: "UTC",
          windows: [
            {
              day: "mon",
              startUtc: "00:00",
              endUtc: "24:00",
              breaks: [{ startUtc: "05:00", endUtc: "06:00" }],
            },
          ],
          sourceNote: "",
        },
      ],
    }).schedules[0];
    expect(isInstantInSchedule("2026-09-07T04:59:00.000Z", schedule)).toBe(true);
    expect(isInstantInSchedule("2026-09-07T05:30:00.000Z", schedule)).toBe(false);
    expect(isInstantInSchedule("2026-09-07T06:00:00.000Z", schedule)).toBe(true);
  });

  it("rejects weekend windows, bad times, non-UTC timezones", () => {
    const base = {
      version: "1.0.0",
      updatedAtUtc: "2026-09-08T00:00:00.000Z",
      schedules: [
        {
          id: "bad",
          description: "x",
          timezone: "UTC",
          windows: [],
          sourceNote: "",
        },
      ],
    };
    const withWindows = (windows: unknown, timezone = "UTC") => ({
      ...base,
      schedules: [{ ...base.schedules[0], timezone, windows }],
    });
    expect(sessionCatalogSchema.safeParse(
      withWindows([{ day: "sat", startUtc: "00:00", endUtc: "24:00", breaks: [] }]),
    ).success).toBe(false);
    expect(sessionCatalogSchema.safeParse(
      withWindows([{ day: "mon", startUtc: "25:00", endUtc: "24:00", breaks: [] }]),
    ).success).toBe(false);
    expect(sessionCatalogSchema.safeParse(withWindows([], "Europe/Berlin")).success).toBe(false);
    expect(() => getSchedule("nope")).toThrow("unknown session schedule");
  });
});

describe("quotes and spreads (P02-01)", () => {
  const quote = {
    instrument: "EURUSD",
    timestamp: "2026-09-08T10:00:00.000Z",
    bid: 1.1085,
    ask: 1.1087,
    isSynthetic: true,
  };

  it("accepts a valid quote and rejects malformed ones", () => {
    expect(quoteSchema.parse(quote)).toEqual(quote);
    expect(quoteSchema.safeParse({ ...quote, timestamp: "2026-09-08T10:00:00Z" }).success).toBe(false);
    expect(quoteSchema.safeParse({ ...quote, bid: -1 }).success).toBe(false);
    expect(quoteSchema.safeParse({ ...quote, extra: 1 }).success).toBe(false);
    expect(quoteSchema.safeParse({}).success).toBe(false);
  });

  it("derives spread in pips using instrument metadata (no literals)", () => {
    const spread = deriveSpread(quoteSchema.parse(quote), EURUSD.precision);
    expect(spread.spreadPrice).toBeCloseTo(0.0002, 10);
    expect(spread.spreadPips).toBeCloseTo(2, 10);
    expect(spread.mid).toBeCloseTo(1.1086, 10);
  });

  it("JPY pip metadata and 3-digit rounding apply to USDJPY", () => {
    const jpyQuote = quoteSchema.parse({
      ...quote,
      instrument: "USDJPY",
      bid: 155.121,
      ask: 155.129,
    });
    const spread = deriveSpread(jpyQuote, getInstrument("USDJPY").precision);
    expect(spread.spreadPips).toBeCloseTo(0.8, 10);
    expect(spread.mid).toBeCloseTo(155.125, 10);
  });

  it("rejects crossed markets (ask < bid) and non-finite prices", () => {
    const crossed = quoteSchema.parse({ ...quote, bid: 1.1087, ask: 1.1085 });
    expect(() => deriveSpread(crossed, EURUSD.precision)).toThrow(/ask < bid/);
    expect(quoteSchema.safeParse({ ...quote, ask: Number.NaN }).success).toBe(false);
    expect(quoteSchema.safeParse({ ...quote, ask: Number.POSITIVE_INFINITY }).success).toBe(false);
  });
});

describe("candles (P02-01)", () => {
  const candle = {
    instrument: "EURUSD",
    timeframe: "5m",
    timestamp: "2026-09-08T10:00:00.000Z",
    open: 1.1085,
    high: 1.1091,
    low: 1.1082,
    close: 1.1088,
    volume: null,
  };

  it("accepts a valid candle (volume null allowed)", () => {
    expect(candleSchema.parse(candle)).toEqual(candle);
  });

  it("rejects impossible OHLC combinations", () => {
    const cases = [
      { ...candle, high: 1.1080 },
      { ...candle, low: 1.1090 },
      { ...candle, high: 1.1082, low: 1.1085 },
      { ...candle, high: -1.1 },
    ];
    for (const bad of cases) {
      expect(candleSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("rejects unknown timeframe, bad timestamp shape, unknown keys", () => {
    expect(candleSchema.safeParse({ ...candle, timeframe: "7m" }).success).toBe(false);
    expect(candleSchema.safeParse({ ...candle, timestamp: "2026-09-08 10:00:00" }).success).toBe(false);
    expect(candleSchema.safeParse({ ...candle, volume: "lots" }).success).toBe(false);
    expect(candleSchema.safeParse({ ...candle, spread: 1 }).success).toBe(false);
    expect(candleSchema.safeParse({}).success).toBe(false);
  });

  it("checks timeframe alignment via isCandleAligned", () => {
    expect(isCandleAligned(candleSchema.parse(candle))).toBe(true);
    const unaligned = candleSchema.parse({
      ...candle,
      timestamp: "2026-09-08T10:03:00.000Z",
    });
    expect(isCandleAligned(unaligned)).toBe(false);
    const daily = candleSchema.parse({
      ...candle,
      timeframe: "1d",
      timestamp: "2026-09-08T00:00:00.000Z",
    });
    expect(isCandleAligned(daily)).toBe(true);
  });
});

describe("registry integrity (P02-01)", () => {
  it("every instrument resolves its schedule and every mapping targets a known instrument", () => {
    expect(validateRegistryIntegrity()).toEqual([]);
  });

  it("exposes frozen, deterministic lookups", () => {
    expect(INSTRUMENTS.size).toBe(8);
    expect(getInstrument("EURUSD")).toBe(getInstrument("EURUSD"));
    expect(() => getInstrument("NOPE")).toThrow("unknown canonical instrument");
    expect(isKnownInstrument("NOPE")).toBe(false);
    expect(isKnownInstrument("EURUSD")).toBe(true);
  });
});
