/**
 * Feature group, lineage and input-window tests (P03-01).
 *
 * Boundary/empty cases, fail-closed window guards, metadata-driven
 * precision passthrough, and the frozen canonical enum sets.
 */
import { describe, expect, it } from "vitest";

import {
  FEATURE_INPUTS,
  FEATURE_NULL_POLICIES,
  FEATURE_OUTPUT_TYPES,
  type Candle,
  type FeatureDefinition,
  type FeatureGroup,
  type FeatureLineage,
  type InputWindow,
  featureGroupSchema,
  featureLineageSchema,
  getInstrument,
  inputWindowFromCandles,
  validateInputWindowForDefinition,
} from "@/index";

const META = { createdAtUtc: "2026-09-08T00:00:00.000Z", notes: "" };

const smaDef: FeatureDefinition = {
  featureId: "sma_close_20",
  version: "1.0.0",
  inputs: ["close"],
  fn: "sma",
  params: { period: 20 },
  lookbackBars: 19,
  outputType: "number",
  nullPolicy: "null_on_warmup",
  description: "20-bar simple moving average of close.",
  metadata: META,
};

describe("featureGroupSchema (P03-01)", () => {
  const group: FeatureGroup = {
    groupId: "core-1h",
    version: "1.0.0",
    timeframe: "1h",
    members: ["sma_close_20", "macd_close"],
    description: "Core 1h feature group.",
    metadata: META,
  };

  it("accepts a valid group", () => {
    expect(featureGroupSchema.parse(group).members).toHaveLength(2);
  });

  it("rejects malformed groups (empty members, bad timeframe, bad casing)", () => {
    expect(featureGroupSchema.safeParse({ ...group, members: [] }).success).toBe(false);
    expect(featureGroupSchema.safeParse({ ...group, timeframe: "2h" }).success).toBe(false);
    expect(featureGroupSchema.safeParse({ ...group, groupId: "Core_1h" }).success).toBe(false);
    expect(featureGroupSchema.safeParse({ ...group, extra: 1 }).success).toBe(false);
  });
});

describe("featureLineageSchema (P03-01)", () => {
  const lineage: FeatureLineage = {
    instrument: "EURUSD",
    timeframe: "1h",
    eventTimeUtc: "2026-09-08T10:00:00.000Z",
    featureGroupId: "core-1h",
    featureGroupVersion: "1.0.0",
    featureIds: ["sma_close_20"],
    dataset: {
      datasetId: "dataset|fixture|EURUSD|1h|2026-09-08T10:00:00.000Z|2026-09-08T12:00:00.000Z",
      checksumDigest: "a".repeat(64),
    },
    featureVersions: { sma_close_20: "1.0.0" },
  };

  it("accepts valid lineage", () => {
    expect(featureLineageSchema.parse(lineage).featureIds).toEqual(["sma_close_20"]);
  });

  it("rejects lineage whose featureVersions reference unknown ids", () => {
    expect(
      featureLineageSchema.safeParse({
        ...lineage,
        featureVersions: { not_declared: "1.0.0" },
      }).success,
    ).toBe(false);
  });

  it("rejects malformed lineage (bad digest, unknown key, naive timestamp)", () => {
    expect(
      featureLineageSchema.safeParse({
        ...lineage,
        dataset: { ...lineage.dataset, checksumDigest: "xyz" },
      }).success,
    ).toBe(false);
    expect(featureLineageSchema.safeParse({ ...lineage, extra: true }).success).toBe(false);
    expect(
      featureLineageSchema.safeParse({ ...lineage, eventTimeUtc: "2026-09-08 10:00:00Z" }).success,
    ).toBe(false);
  });
});

describe("input windows (P03-01)", () => {
  const EURUSD = getInstrument("EURUSD");

  function candles(): Candle[] {
    return [
      {
        instrument: "EURUSD",
        timeframe: "1h",
        timestamp: "2026-09-08T10:00:00.000Z",
        open: 1.1,
        high: 1.101,
        low: 1.099,
        close: 1.1005,
        volume: null,
      },
      {
        instrument: "EURUSD",
        timeframe: "1h",
        timestamp: "2026-09-08T11:00:00.000Z",
        open: 1.1005,
        high: 1.102,
        low: 1.1,
        close: 1.101,
        volume: null,
      },
    ];
  }

  it("builds a typed window from canonical candles", () => {
    const window: InputWindow = inputWindowFromCandles(EURUSD, "1h", candles(), ["close", "volume"]);
    expect(window.length).toBe(2);
    expect(window.rows[0].values.close).toBe(1.1005);
    expect(window.rows[0].values.volume).toBeNull();
    expect(window.instrument).toBe("EURUSD");
    expect(window.precision.pip).toBeCloseTo(0.0001, 10);
  });

  it("empty window is a valid boundary case (zero rows)", () => {
    const window = inputWindowFromCandles(EURUSD, "1h", [], ["close"]);
    expect(window.length).toBe(0);
  });

  it("rejects instrument/timeframe mismatches and mid inputs (fail closed)", () => {
    const GBP = getInstrument("GBPUSD");
    expect(() => inputWindowFromCandles(GBP, "1h", candles(), ["close"])).toThrow(/mismatch/);
    expect(() => inputWindowFromCandles(EURUSD, "5m", candles(), ["close"])).toThrow(/mismatch/);
    expect(() => inputWindowFromCandles(EURUSD, "1h", candles(), ["mid"])).toThrow(/mid/);
  });

  it("validateInputWindowForDefinition enforces declared inputs", () => {
    const window = inputWindowFromCandles(EURUSD, "1h", candles(), ["close", "volume"]);
    expect(() => validateInputWindowForDefinition(window, smaDef)).not.toThrow();
    // A definition needing a field the window lacks.
    const sparse: InputWindow = {
      ...window,
      rows: window.rows.map((r) => ({ timestamp: r.timestamp, values: { open: r.values.open } })),
    };
    expect(() => validateInputWindowForDefinition(sparse, smaDef)).toThrow(/missing field close/);
    // Null close (non-volume null) is rejected.
    const nullClose: InputWindow = {
      ...window,
      rows: window.rows.map((r) => ({
        timestamp: r.timestamp,
        values: { ...r.values, close: null },
      })),
    };
    expect(() => validateInputWindowForDefinition(nullClose, smaDef)).toThrow(/null/);
  });

  it("canonical input/output enums stay locked", () => {
    expect(FEATURE_INPUTS).toEqual(["close", "high", "low", "open", "volume", "mid"]);
    expect(FEATURE_OUTPUT_TYPES).toEqual(["number", "boolean"]);
    expect(FEATURE_NULL_POLICIES).toEqual(["null_on_warmup", "null_on_insufficient_data"]);
  });
});
