import { z } from "zod";

import type { Candle } from "../marketdata/candle";
import type { DatasetManifest } from "../marketdata/dataset";
import type { Instrument, InstrumentPrecision } from "../marketdata/instrument";
import { instrumentIdSchema } from "../marketdata/instrument";
import { timeframeSchema, utcInstantSchema, type Timeframe } from "../marketdata/time";

/** Feature value types a definition may declare as its output. */
export const FEATURE_OUTPUT_TYPES = ["number", "boolean"] as const;
export type FeatureOutputType = (typeof FEATURE_OUTPUT_TYPES)[number];
export const featureOutputTypeSchema = z.enum(FEATURE_OUTPUT_TYPES);

/**
 * Canonical inputs (subset of the market-data model):
 * `close/high/low/open` — candle series fields; `volume` — candle volume
 * series (null bars yield null); `mid` — quote mid series (later phases).
 */
export const FEATURE_INPUTS = ["close", "high", "low", "open", "volume", "mid"] as const;
export type FeatureInputName = (typeof FEATURE_INPUTS)[number];
export const featureInputNameSchema = z.enum(FEATURE_INPUTS);

/**
 * Null policy: how a feature behaves when it cannot be computed.
 * `null_on_warmup` — deterministic warmup returns null;
 * `null_on_insufficient_data` — a malformed/gappy input fails the whole
 * snapshot (fail closed, no invented bars).
 */
export const FEATURE_NULL_POLICIES = [
  "null_on_warmup",
  "null_on_insufficient_data",
] as const;
export type FeatureNullPolicy = (typeof FEATURE_NULL_POLICIES)[number];
export const featureNullPolicySchema = z.enum(FEATURE_NULL_POLICIES);

/** Semver-ish version string, e.g. `1.0.0`. */
export const featureVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

/** Deterministic transform functions (core indicators, P03-02). */
export const FEATURE_FUNCTIONS = ["sma", "ema", "rsi", "atr", "adx", "macd"] as const;
export type FeatureFunction = (typeof FEATURE_FUNCTIONS)[number];
export const featureFunctionSchema = z.enum(FEATURE_FUNCTIONS);

/** Function parameters (name -> number/string; may be empty). */
export const functionParamsSchema = z.record(z.string(), z.union([z.number(), z.string()]));


/** Number of prior bars a function must see before emitting non-null values. */
export function functionLookback(
  fn: FeatureFunction,
  params: Readonly<Record<string, number | string>>,
): number {
  const period = typeof params.period === "number" ? params.period : 0;
  switch (fn) {
    case "sma":
      return Math.max(period - 1, 0);
    case "ema":
      return period - 1;
    case "rsi":
      return period;
    case "atr":
      return period;
    case "adx": {
      const adxPeriod = typeof params.adxPeriod === "number" ? params.adxPeriod : period;
      return 2 * adxPeriod - 1;
    }
    case "macd": {
      const fast = typeof params.fast === "number" ? params.fast : 12;
      const slow = typeof params.slow === "number" ? params.slow : 26;
      const signal = typeof params.signal === "number" ? params.signal : 9;
      return slow - 1 + signal - 1;
    }
  }
}

/**
 * Versioned FeatureDefinition.
 *
 * Every definition declares version, inputs, lookback and output type —
 * the P03-01 acceptance criterion. Frozen shape: featureId (snake_case),
 * semver version, inputs (canonical series fields), fn (deterministic
 * transform), params, lookbackBars (warmup length), outputType, nullPolicy,
 * description and metadata (UTC creation + provenance notes, no secrets).
 */
export const featureDefinitionSchema = z
  .object({
    featureId: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/, "featureId must be snake_case"),
    version: featureVersionSchema,
    inputs: z.array(featureInputNameSchema).min(1).max(FEATURE_INPUTS.length),
    fn: featureFunctionSchema,
    params: functionParamsSchema,
    lookbackBars: z.number().int().min(0),
    outputType: featureOutputTypeSchema,
    nullPolicy: featureNullPolicySchema,
    description: z.string().min(1),
    metadata: z
      .object({
        createdAtUtc: utcInstantSchema,
        /** Provenance notes (doc references, not secrets). */
        notes: z.string().min(0),
      })
      .strict(),
  })
  .strict()
  .superRefine((def, ctx) => {
    if (new Set(def.inputs).size !== def.inputs.length) {
      ctx.addIssue({ code: "custom", path: ["inputs"], message: "inputs must be unique" });
    }
    const expected = functionLookback(def.fn, def.params);
    if (def.lookbackBars !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["lookbackBars"],
        message: `lookbackBars must equal the warmup of fn ${def.fn} (${expected})`,
      });
    }
  });

export type FeatureDefinition = z.infer<typeof featureDefinitionSchema>;

/**
 * Feature group: a named bundle of feature definitions that share an input
 * timeframe and are computed together (e.g. `core-1h`, `core-5m`).
 */
export const featureGroupSchema = z
  .object({
    groupId: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "groupId must be kebab-case"),
    version: featureVersionSchema,
    /** Timeframe whose candles feed the group's definitions. */
    timeframe: timeframeSchema,
    /** Constituent definition ids (must resolve in the registry). */
    members: z.array(z.string().min(1)).min(1),
    description: z.string().min(1),
    metadata: z
      .object({
        createdAtUtc: utcInstantSchema,
        notes: z.string().min(0),
      })
      .strict(),
  })
  .strict();

export type FeatureGroup = z.infer<typeof featureGroupSchema>;

/**
 * The full lineage needed to reproduce a feature value: what was computed
 * (feature ids + versions), from what (instrument, timeframe, feature-group
 * version), from which data (dataset id + manifest checksum digest) and at
 * what time (event time, UTC). This is the lineage-metadata contract.
 */
export const featureLineageSchema = z
  .object({
    instrument: instrumentIdSchema,
    timeframe: timeframeSchema,
    eventTimeUtc: utcInstantSchema,
    featureGroupId: z.string().min(1),
    featureGroupVersion: featureVersionSchema,
    featureIds: z.array(z.string().min(1)).min(1),
    /** Data snapshot lineage (P02-05 manifest). */
    dataset: z
      .object({
        datasetId: z.string().min(1).max(128),
        /** Manifest checksum digest of the exact input data used. */
        checksumDigest: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    /** Feature definitions used, by featureId (id -> version). */
    featureVersions: z.record(z.string(), featureVersionSchema),
  })
  .strict()
  .refine(
    (l) => {
      const set = new Set(l.featureIds);
      return Object.keys(l.featureVersions).every((id) => set.has(id));
    },
    { message: "featureVersions keys must be a subset of featureIds", path: ["featureVersions"] },
  );

export type FeatureLineage = z.infer<typeof featureLineageSchema>;

/**
 * Typed input series access for computations: guarantees the fields a
 * definition declared exist on the input window and carries instrument
 * metadata (pip size etc. from the catalog — never hardcoded by consumers).
 */
export interface InputWindow {
  readonly instrument: Instrument["id"];
  readonly timeframe: Timeframe;
  /** Input rows, ascending by candle open time. */
  readonly rows: ReadonlyArray<{
    timestamp: string;
    values: Record<string, number | null>;
  }>;
  /** Number of rows. */
  readonly length: number;
  /** Instrument precision metadata (pip, point, digits). */
  readonly precision: InstrumentPrecision;
}

/**
 * Build a typed InputWindow from canonical candles.
 *
 * `close/high/low/open/volume` come from candles; `mid` requires a
 * quote-derived series and is rejected here (fail closed, no invention).
 */
export function inputWindowFromCandles(
  instrument: Instrument,
  timeframe: Timeframe,
  candles: readonly Candle[],
  inputs: readonly FeatureInputName[],
): InputWindow {
  const first = candles[0];
  if (candles.length > 0 && first.instrument !== instrument.id) {
    throw new Error(
      `instrument mismatch: window is for ${instrument.id}, candles are for ${first.instrument}`,
    );
  }
  if (inputs.includes("mid")) {
    throw new Error("mid input requires a quote-derived series (not candle-only)");
  }
  for (const candle of candles) {
    if (candle.timeframe !== timeframe) {
      throw new Error(
        `timeframe mismatch: window is ${timeframe}, candle ${candle.timestamp} is ${candle.timeframe}`,
      );
    }
  }
  const rows = candles.map((candle) => ({
    timestamp: candle.timestamp,
    values: {
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    } as Record<string, number | null>,
  }));
  return {
    instrument: instrument.id,
    timeframe,
    rows,
    length: rows.length,
    precision: instrument.precision,
  };
}

/**
 * Validate that an input window satisfies a definition's declared inputs:
 * every declared field must be present in every row (null allowed only for
 * nullable fields: volume). Fail closed — a missing field is a caller bug.
 */
export function validateInputWindowForDefinition(
  window: InputWindow,
  definition: FeatureDefinition,
): void {
  for (const input of definition.inputs) {
    if (input === "mid") {
      throw new Error(`input ${input} is not available in a candle window`);
    }
    for (const row of window.rows) {
      const value = row.values[input];
      if (value === undefined) {
        throw new Error(
          `input window is missing field ${input} at ${row.timestamp}`,
        );
      }
      if (value === null && input !== "volume") {
        throw new Error(`input ${input} is null at ${row.timestamp} (only volume may be null)`);
      }
    }
  }
}

/**
 * The dataset snapshot lineage bound into feature lineage: the manifest of
 * the candles that fed the computation (P02-05 contract, reused).
 */
export function lineageForDataset(
  manifest: DatasetManifest,
): Pick<FeatureLineage["dataset"], "datasetId" | "checksumDigest"> {
  return {
    datasetId: manifest.datasetId,
    checksumDigest: manifest.checksum.digest,
  };
}
