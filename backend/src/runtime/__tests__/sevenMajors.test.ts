import { describe, expect, it } from "vitest";

import type { InstrumentId, MarketDataProvider } from "@fdbtrade/contracts";

import { FixtureProvider } from "@/data/providers/fixture";
import {
  SEVEN_MAJOR_CACHED_RANGES_PER_PAIR,
  SEVEN_MAJOR_CONFIG,
  SEVEN_MAJOR_PAIRS,
  SEVEN_MAJOR_SHED_REASONS,
  replaySevenMajors,
} from "@/runtime/sevenMajors";

const range = {
  timeframe: "1h" as const,
  startUtc: "2026-09-08T08:00:00.000Z",
  endUtc: "2026-09-08T12:00:00.000Z",
};

/**
 * Deterministic fault provider: duplicates the last bar of ONE pair so the
 * P02-03 quality gate quarantines a row for that pair only. It never invents
 * "clean" data for the affected pair.
 */
function duplicateLastBarProvider(instrument: InstrumentId): MarketDataProvider {
  const base = new FixtureProvider();
  return {
    id: base.id,
    capabilities: () => base.capabilities(),
    getHistoricalCandles: async (request) => {
      const candles = [...(await base.getHistoricalCandles(request))];
      if (request.instrument === instrument && candles.length > 0) {
        candles.push(candles[candles.length - 1]);
      }
      return candles;
    },
    getQuotes: (request) => base.getQuotes(request),
    health: () => base.health(),
  };
}

describe("M47 seven-major fixture runtime", () => {
  it("uses exactly seven configured external pairs mapped to canonical catalog instruments", () => {
    expect(SEVEN_MAJOR_PAIRS).toEqual([
      "EUR_USD", "GBP_USD", "USD_JPY", "USD_CHF", "AUD_USD", "USD_CAD", "NZD_USD",
    ]);
    expect(SEVEN_MAJOR_CONFIG.map((row) => row.canonicalInstrument)).toEqual([
      "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD",
    ]);
  });

  it("replays all majors with fixture provenance and bounded per-pair caches", async () => {
    const result = await replaySevenMajors(range);
    expect(result.pairs).toHaveLength(7);
    expect(result.pairs.every((row) => row.state === "fresh")).toBe(true);
    expect(result.pairs.every((row) => row.acceptedCandles > 0 && row.provenance === "fixture")).toBe(true);
    expect(result.resources).toEqual({
      configuredPairs: 7,
      completedPairs: 7,
      failedPairs: 0,
      shedPairs: 0,
      degradationLevel: "normal",
      maxCachedRanges: SEVEN_MAJOR_CACHED_RANGES_PER_PAIR * SEVEN_MAJOR_CONFIG.length,
    });
  });

  it("measures per-pair quarantine rows without substituting data", async () => {
    const result = await replaySevenMajors(range, {
      provider: duplicateLastBarProvider("GBPUSD"),
    });
    const affected = result.pairs.find((row) => row.pair === "GBP_USD");
    expect(affected).toMatchObject({ state: "quarantined", quarantinedRows: 1, error: null });
    expect(affected?.acceptedCandles).toBeGreaterThan(0);
    expect(
      result.pairs
        .filter((row) => row.pair !== "GBP_USD")
        .every((row) => row.quarantinedRows === 0 && row.state === "fresh"),
    ).toBe(true);
    expect(result.resources).toMatchObject({ completedPairs: 7, failedPairs: 0, shedPairs: 0 });
  });

  it("sheds every pair when admission is suspended (no data invented)", async () => {
    const result = await replaySevenMajors(range, { pressure: { heapRatio: 0.95 } });
    expect(result.resources).toMatchObject({
      degradationLevel: "suspended",
      completedPairs: 0,
      failedPairs: 7,
      shedPairs: 7,
    });
    expect(
      result.pairs.every(
        (row) =>
          row.state === "unavailable" &&
          row.acceptedCandles === 0 &&
          row.error === SEVEN_MAJOR_SHED_REASONS.suspended,
      ),
    ).toBe(true);
  });

  it("observation-only admission keeps a bounded observation budget", async () => {
    const result = await replaySevenMajors(range, { degradationLevel: "conservative" });
    expect(result.resources).toMatchObject({
      degradationLevel: "conservative",
      completedPairs: 1,
      failedPairs: 6,
      shedPairs: 6,
    });
    expect(result.pairs[0]).toMatchObject({ pair: "EUR_USD", state: "fresh", provenance: "fixture" });
    expect(
      result.pairs
        .slice(1)
        .every((row) => row.error === SEVEN_MAJOR_SHED_REASONS.observationOnly),
    ).toBe(true);
  });

  it("an explicit level raises degradation but never weakens a suspended admission", async () => {
    const result = await replaySevenMajors(range, {
      pressure: { freeDiskRatio: 0.01 },
      degradationLevel: "normal",
    });
    expect(result.resources.degradationLevel).toBe("suspended");
    expect(
      result.pairs.every((row) => row.error === SEVEN_MAJOR_SHED_REASONS.suspended),
    ).toBe(true);
  });

  it("restart: an independent re-run reproduces the projection byte-for-byte", async () => {
    const first = await replaySevenMajors(range);
    const second = await replaySevenMajors(range);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("crash recovery: a failed pair never poisons the next replay", async () => {
    const crashed = await replaySevenMajors(range, { failPairs: ["USD_JPY"] });
    expect(crashed.pairs.find((row) => row.pair === "USD_JPY")?.state).toBe("unavailable");
    const recovered = await replaySevenMajors(range);
    expect(recovered.pairs.every((row) => row.state === "fresh")).toBe(true);
    expect(recovered.resources).toMatchObject({ completedPairs: 7, failedPairs: 0, shedPairs: 0 });
  });

  it("performance and memory evidence: one fixture week across all seven pairs", async () => {
    const week = {
      timeframe: "1h" as const,
      startUtc: "2026-09-01T00:00:00.000Z",
      endUtc: "2026-09-08T00:00:00.000Z",
    };
    const startedMs = Date.now();
    const result = await replaySevenMajors(week);
    const elapsedMs = Date.now() - startedMs;
    // Generous ceiling: catches accidental unbounded work without being flaky.
    expect(elapsedMs).toBeLessThan(30_000);
    expect(result.pairs.every((row) => row.state === "fresh" && row.acceptedCandles > 0)).toBe(true);
    expect(result.resources.maxCachedRanges).toBe(
      SEVEN_MAJOR_CACHED_RANGES_PER_PAIR * SEVEN_MAJOR_CONFIG.length,
    );
  });

  it("isolates one failed pair without fixture substitution or unrelated outage", async () => {
    const result = await replaySevenMajors(range, { failPairs: ["USD_JPY"] });
    const failed = result.pairs.find((row) => row.pair === "USD_JPY");
    expect(failed).toMatchObject({ state: "unavailable", acceptedCandles: 0, error: "fault_injected_pair_unavailable" });
    expect(result.pairs.filter((row) => row.pair !== "USD_JPY").every((row) => row.state === "fresh")).toBe(true);
    expect(result.resources).toMatchObject({ completedPairs: 6, failedPairs: 1 });
  });

  it("fails closed for an unsupported runtime timeframe", async () => {
    await expect(replaySevenMajors({ ...range, timeframe: "5m" })).rejects.toThrow("supports 1h only");
  });
});
