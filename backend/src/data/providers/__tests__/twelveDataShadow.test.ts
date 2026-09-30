import { describe, expect, it } from "vitest";

import { TwelveDataBudget, type BoundaryResult, type TwelveDataPorts } from "../twelveDataBoundary";
import {
  compareTwelveDataShadow,
  normalizeTwelveDataShadowPayload,
  parseCanonicalAuthorityArtifact,
  runTwelveDataShadow,
} from "../twelveDataShadow";

const query = { pair: "EUR/USD", interval: "1h", outputsize: 3 } as const;
const observedAtUtc = "2026-09-30T12:30:00.000Z";
const payload = JSON.stringify({
  meta: { symbol: "EUR/USD", interval: "1h", exchange_timezone: "UTC" },
  values: [
    { datetime: "2026-09-30 12:00:00", open: "1.1020", high: "1.1030", low: "1.1010", close: "1.1025" },
    { datetime: "2026-09-30 11:00:00", open: "1.1010", high: "1.1020", low: "1.1000", close: "1.1015" },
    { datetime: "2026-09-30 10:00:00", open: "1.1000", high: "1.1010", low: "1.0990", close: "1.1005" },
  ],
  status: "ok",
});
const reference = [
  "EURUSD|1h|2026-09-30T09:00:00.000Z|1.099|1.100|1.098|1.0995|-",
  "EURUSD|1h|2026-09-30T10:00:00.000Z|1.1001|1.1011|1.0991|1.1006|-",
  "EURUSD|1h|2026-09-30T11:00:00.000Z|1.1012|1.1022|1.1002|1.1017|-",
].join("\n");

function ports(): TwelveDataPorts {
  return {
    resolve: async () => ["8.8.8.8"],
    send: async () => ({ status: 200, bodyText: payload }),
    sleep: async () => undefined,
    nowMs: () => 0,
    audit: () => undefined,
  };
}

describe("Twelve Data R1.16 read-only shadow", () => {
  it("normalizes descending UTC rows and excludes a still-open candle", () => {
    const normalized = normalizeTwelveDataShadowPayload({ bodyText: payload, query, observedAtUtc });
    expect(normalized.candles.map((candle) => candle.timestamp)).toEqual([
      "2026-09-30T10:00:00.000Z",
      "2026-09-30T11:00:00.000Z",
      "2026-09-30T12:00:00.000Z",
    ]);
    expect(normalized.closedCandles).toHaveLength(2);
    expect(normalized.excludedOpenTimestamps).toEqual(["2026-09-30T12:00:00.000Z"]);
    expect(normalized.duplicateTimestamps).toBe(0);
  });

  it("compares coverage, closure, timestamps and OHLC drift without publishing", () => {
    const normalized = normalizeTwelveDataShadowPayload({ bodyText: payload, query, observedAtUtc });
    const authority = parseCanonicalAuthorityArtifact({
      bodyText: reference, instrument: "EURUSD", timeframe: "1h",
    });
    const report = compareTwelveDataShadow({
      normalized, referenceCandles: authority, observedAtUtc, pipSize: 0.0001,
    });
    expect(report.coverage).toMatchObject({
      matchedBars: 2,
      referenceOnlyTimestamps: ["2026-09-30T09:00:00.000Z"],
      providerOnlyTimestamps: [],
      referenceCoverageRatio: 0.66666667,
      providerCoverageRatio: 1,
    });
    expect(report.drift).toEqual({
      matchedBars: 2,
      meanMaxAbsDeltaPips: 1.5,
      worstMaxAbsDeltaPips: 2,
    });
    expect(report.timestamps).toEqual({ ascending: true, aligned: true, duplicates: 0 });
    expect(report.authority).toEqual({
      published: false,
      mutated: false,
      eligibleForSignals: false,
      eligibleForResearch: false,
      eligibleForPaper: false,
    });
  });

  it("rejects malformed, mismatched, duplicate and unaligned provider evidence", () => {
    expect(() => normalizeTwelveDataShadowPayload({
      bodyText: "{", query, observedAtUtc,
    })).toThrow("not valid JSON");
    expect(() => normalizeTwelveDataShadowPayload({
      bodyText: JSON.stringify({ ...JSON.parse(payload), meta: { symbol: "GBP/USD", interval: "1h" } }),
      query, observedAtUtc,
    })).toThrow("does not match");
    const duplicated = JSON.parse(payload);
    duplicated.values[1].datetime = duplicated.values[0].datetime;
    expect(() => normalizeTwelveDataShadowPayload({
      bodyText: JSON.stringify(duplicated), query, observedAtUtc,
    })).toThrow("duplicate");
    const unaligned = JSON.parse(payload);
    unaligned.values[0].datetime = "2026-09-30 12:30:00";
    expect(() => normalizeTwelveDataShadowPayload({
      bodyText: JSON.stringify(unaligned), query, observedAtUtc,
    })).toThrow("off the timeframe grid");
  });

  it("fails closed on a missing credential and never substitutes fixture data", async () => {
    const executeRead = async (): Promise<BoundaryResult> => ({
      ok: false, code: "secret_missing", detail: "missing twelve-data.json", attempts: 0,
    });
    const result = await runTwelveDataShadow({
      configDir: "/absent",
      query,
      observedAtUtc,
      referenceArtifactText: reference,
      pipSize: 0.0001,
      ports: ports(),
      budget: new TwelveDataBudget(0),
      executeRead,
    });
    expect(result).toEqual({
      status: "blocked",
      code: "secret_missing",
      detail: "missing twelve-data.json",
      authority: { published: false, mutated: false },
    });
  });

  it("uses only an injected boundary executor in hermetic tests", async () => {
    const executeRead = async (): Promise<BoundaryResult> => ({
      ok: true,
      status: 200,
      bodyText: payload,
      attempts: 1,
      credentialFingerprint: "0123456789abcdef",
    });
    const result = await runTwelveDataShadow({
      configDir: "/not-read-by-fake",
      query,
      observedAtUtc,
      referenceArtifactText: reference,
      pipSize: 0.0001,
      ports: ports(),
      budget: new TwelveDataBudget(0),
      executeRead,
    });
    expect(result.status).toBe("compared");
    expect(JSON.stringify(result)).not.toContain("credentialFingerprint");
    expect(JSON.stringify(result)).not.toContain("0123456789abcdef");
  });
});