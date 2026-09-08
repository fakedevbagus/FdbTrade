/**
 * Canonical market-data model tests (P02-01).
 *
 * Covers: valid inputs/expected outputs, malformed/missing input rejection,
 * boundary/empty/stale-adjacent cases, determinism, and the "metadata from
 * data, not literals" invariant.
 */
import { describe, expect, it } from "vitest";

import {
  CANONICAL_IDS,
  TIMEFRAME_MS,
  TIMEFRAMES,
  alignToTimeframe,
  getInstrument,
  instrumentCatalog,
  instrumentCatalogSchema,
  mapProviderSymbol,
  quoteSchema,
  reverseMapProviderSymbol,
  sessionCatalogSchema,
  symbolMappingTableSchema,
  utcInstantSchema,
} from "@/index";

const EURUSD = getInstrument("EURUSD");
const USDJPY = getInstrument("USDJPY");
const XAUUSD = getInstrument("XAUUSD");

describe("utcInstantSchema (P02-01)", () => {
  it("accepts millisecond-precision UTC instants", () => {
    expect(utcInstantSchema.parse("2026-09-08T10:00:00.000Z")).toBe(
      "2026-09-08T10:00:00.000Z",
    );
  });

  it("rejects offset, naive, and non-millisecond forms", () => {
    expect(utcInstantSchema.safeParse("2026-09-08T10:00:00+02:00").success).toBe(false);
    expect(utcInstantSchema.safeParse("2026-09-08T10:00:00Z").success).toBe(false);
    expect(utcInstantSchema.safeParse("2026-09-08T10:00:00.000000Z").success).toBe(false);
    expect(utcInstantSchema.safeParse("2026-09-08 10:00:00.000Z").success).toBe(false);
    expect(utcInstantSchema.safeParse(1694167200000).success).toBe(false);
    expect(utcInstantSchema.safeParse("").success).toBe(false);
  });

  it("is deterministic for deterministic input", () => {
    expect(utcInstantSchema.parse("2026-01-01T00:00:00.000Z")).toBe(
      utcInstantSchema.parse("2026-01-01T00:00:00.000Z"),
    );
  });
});

describe("timeframes (P02-01)", () => {
  it("matches the frozen blueprint set", () => {
    expect(TIMEFRAMES).toEqual(["5m", "15m", "1h", "4h", "1d"]);
    expect(TIMEFRAME_MS["5m"]).toBe(300_000);
    expect(TIMEFRAME_MS["15m"]).toBe(900_000);
    expect(TIMEFRAME_MS["1h"]).toBe(3_600_000);
    expect(TIMEFRAME_MS["4h"]).toBe(14_400_000);
    expect(TIMEFRAME_MS["1d"]).toBe(86_400_000);
  });

  it("aligns intraday instants to the open-time grid", () => {
    expect(alignToTimeframe("2026-09-08T10:03:41.000Z", "5m")).toBe(
      "2026-09-08T10:00:00.000Z",
    );
    expect(alignToTimeframe("2026-09-08T10:59:59.999Z", "15m")).toBe(
      "2026-09-08T10:45:00.000Z",
    );
    expect(alignToTimeframe("2026-09-08T23:59:59.999Z", "1h")).toBe(
      "2026-09-08T23:00:00.000Z",
    );
  });

  it("aligns 1d instants to UTC midnight of the same calendar day", () => {
    expect(alignToTimeframe("2026-09-08T18:44:12.512Z", "1d")).toBe(
      "2026-09-08T00:00:00.000Z",
    );
    expect(alignToTimeframe("2026-09-08T00:00:00.000Z", "1d")).toBe(
      "2026-09-08T00:00:00.000Z",
    );
  });
});

describe("instrument catalog (P02-01)", () => {
  it("contains the blueprint trading universe", () => {
    expect(CANONICAL_IDS).toEqual([
      "EURUSD",
      "GBPUSD",
      "USDJPY",
      "AUDUSD",
      "USDCAD",
      "USDCHF",
      "NZDUSD",
      "XAUUSD",
    ]);
  });

  it("precision metadata comes from data files, per instrument", () => {
    expect(EURUSD.precision.digits).toBe(5);
    expect(EURUSD.precision.pip).toBeCloseTo(0.0001, 10);
    expect(EURUSD.precision.point).toBeCloseTo(0.00001, 12);
    expect(USDJPY.precision.pip).toBeCloseTo(0.01, 10);
    expect(USDJPY.precision.point).toBeCloseTo(0.001, 10);
    expect(USDJPY.precision.digits).toBe(3);
    expect(XAUUSD.precision.digits).toBe(2);
    expect(XAUUSD.precision.pip).toBeCloseTo(0.1, 10);
    expect(EURUSD.contractSpec.contractSize).toBe(100_000);
    expect(XAUUSD.contractSpec.contractSize).toBe(100);
  });

  it("rejects malformed catalogs (fail closed)", () => {
    const bad = {
      ...instrumentCatalog,
      instruments: [{ ...EURUSD, precision: { ...EURUSD.precision, pip: 0 } }],
    };
    expect(instrumentCatalogSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects unknown keys in an instrument (frozen shape)", () => {
    const bad = { ...EURUSD, surprise: true };
    expect(instrumentCatalogSchema.safeParse({
      ...instrumentCatalog,
      instruments: [bad],
    }).success).toBe(false);
  });
});

describe("symbol mappings (P02-01)", () => {
  it("are versioned and resolve fixture provider symbols", () => {
    const table = symbolMappingTableSchema.parse({
      version: "1.0.0",
      updatedAtUtc: "2026-09-08T00:00:00.000Z",
      entries: [
        { providerId: "fixture", providerSymbol: "EURUSD", canonicalId: "EURUSD" },
      ],
    });
    expect(table.version).toBe("1.0.0");
    expect(mapProviderSymbol("fixture", "EURUSD")).toBe("EURUSD");
    expect(reverseMapProviderSymbol("fixture", "XAUUSD")).toBe("XAUUSD");
  });

  it("returns null for unmapped provider symbols", () => {
    expect(mapProviderSymbol("fixture", "NOT-A-SYMBOL")).toBeNull();
    expect(mapProviderSymbol("unknown-provider", "EURUSD")).toBeNull();
    expect(reverseMapProviderSymbol("unknown-provider", "EURUSD")).toBeNull();
  });

  it("rejects malformed mapping tables", () => {
    expect(symbolMappingTableSchema.safeParse({
      version: "1.0.0",
      updatedAtUtc: "2026-09-08T00:00:00.000Z",
      entries: [],
    }).success).toBe(false);
    expect(symbolMappingTableSchema.safeParse({
      version: "v1",
      updatedAtUtc: "2026-09-08T00:00:00.000Z",
      entries: [{ providerId: "fixture", providerSymbol: "E", canonicalId: "EURUSD" }],
    }).success).toBe(false);
  });
});
