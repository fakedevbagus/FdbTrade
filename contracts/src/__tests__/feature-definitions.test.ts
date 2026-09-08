/**
 * Feature definition/group/lineage schema tests (P03-01).
 *
 * Acceptance: "Every feature declares version, inputs, lookback and output
 * type; feature schema tests pass." Covers valid input/expected output,
 * malformed/missing input, boundary (empty/warmup) cases, determinism and
 * cross-layer invariants (lookback table, input-window guards).
 */
import { describe, expect, it } from "vitest";

import {
  FEATURE_INPUTS,
  FEATURE_NULL_POLICIES,
  FEATURE_OUTPUT_TYPES,
  type FeatureDefinition,
  type FeatureGroup,
  type FeatureLineage,
  featureDefinitionSchema,
  featureGroupSchema,
  featureLineageSchema,
  functionLookback,
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

const macdDef: FeatureDefinition = {
  featureId: "macd_close",
  version: "1.0.0",
  inputs: ["close"],
  fn: "macd",
  params: { fast: 12, slow: 26, signal: 9 },
  lookbackBars: 33,
  outputType: "number",
  nullPolicy: "null_on_warmup",
  description: "MACD(12,26,9) histogram value.",
  metadata: META,
};

describe("featureDefinitionSchema (P03-01)", () => {
  it("accepts a valid definition with declared version/inputs/lookback/output", () => {
    const parsed = featureDefinitionSchema.parse(smaDef);
    expect(parsed.featureId).toBe("sma_close_20");
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.inputs).toEqual(["close"]);
    expect(parsed.lookbackBars).toBe(19);
    expect(parsed.outputType).toBe("number");
  });

  it("is deterministic for the same input", () => {
    expect(featureDefinitionSchema.parse(smaDef)).toEqual(featureDefinitionSchema.parse(smaDef));
  });

  it("rejects missing required fields (fail closed)", () => {
    const missing = { ...smaDef } as Record<string, unknown>;
    for (const key of ["version", "inputs", "lookbackBars", "outputType", "nullPolicy"]) {
      delete missing[key];
    }
    expect(featureDefinitionSchema.safeParse(missing).success).toBe(false);
  });

  it("rejects unknown keys (frozen shape)", () => {
    expect(featureDefinitionSchema.safeParse({ ...smaDef, surprise: 1 }).success).toBe(false);
  });

  it("rejects non-snake-case ids and non-semver versions", () => {
    expect(featureDefinitionSchema.safeParse({ ...smaDef, featureId: "Bad-ID" }).success).toBe(false);
    expect(featureDefinitionSchema.safeParse({ ...smaDef, version: "v1" }).success).toBe(false);
    expect(featureDefinitionSchema.safeParse({ ...smaDef, version: "1.0" }).success).toBe(false);
  });

  it("rejects duplicate inputs and unknown input names", () => {
    expect(featureDefinitionSchema.safeParse({ ...smaDef, inputs: ["close", "close"] }).success).toBe(false);
    expect(featureDefinitionSchema.safeParse({ ...smaDef, inputs: ["unknown"] }).success).toBe(false);
    expect(featureDefinitionSchema.safeParse({ ...smaDef, inputs: [] }).success).toBe(false);
  });

  it("rejects unknown output types and null policies", () => {
    expect(featureDefinitionSchema.safeParse({ ...smaDef, outputType: "string" }).success).toBe(false);
    expect(featureDefinitionSchema.safeParse({ ...smaDef, nullPolicy: "zero_fill" }).success).toBe(false);
  });

  it("rejects a lookback that contradicts the declared function warmup", () => {
    expect(featureDefinitionSchema.safeParse({ ...smaDef, lookbackBars: 5 }).success).toBe(false);
    expect(featureDefinitionSchema.safeParse({ ...smaDef, lookbackBars: -1 }).success).toBe(false);
    // MACD lookback is (slow-1)+(signal-1) = 33, not a free choice.
    expect(featureDefinitionSchema.safeParse({ ...macdDef, lookbackBars: 25 }).success).toBe(false);
    expect(featureDefinitionSchema.parse(macdDef).lookbackBars).toBe(33);
  });
});

describe("functionLookback (P03-01)", () => {
  it("derives the warmup table deterministically", () => {
    expect(functionLookback("sma", { period: 20 })).toBe(19);
    expect(functionLookback("ema", { period: 20 })).toBe(19);
    expect(functionLookback("rsi", { period: 14 })).toBe(14);
    expect(functionLookback("atr", { period: 14 })).toBe(14);
    expect(functionLookback("adx", { period: 14, adxPeriod: 14 })).toBe(27);
    expect(functionLookback("macd", { fast: 12, slow: 26, signal: 9 })).toBe(33);
  });

  it("boundary: period 1 sma has zero warmup", () => {
    expect(functionLookback("sma", { period: 1 })).toBe(0);
  });
});
