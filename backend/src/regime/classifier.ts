/**
 * Deterministic baseline regime classifier (P04-02).
 *
 * Rule-based classification over P03 features (ADR-0016):
 * - trend strength: ADX (P03-02);
 * - volatility: ATR as fraction of close (P03-03), compared against a
 *   rolling baseline computed from STRICTLY PRIOR bars (no self-inclusion,
 *   no look-ahead);
 * - structure: rolling least-squares slope of close in pips/bar (P03-03).
 *
 * Rule order per bar (first match wins):
 *   1. any required feature missing            -> unknown (missing_feature)
 *   2. fewer than volWindow prior ATR values   -> unknown (insufficient_history)
 *   3. atrRatio >= highVolRatio                -> high_volatility
 *   4. atrRatio <= lowVolRatio                 -> low_volatility
 *   5. ADX >= trendAdx AND |slope| >= minSlope -> trend
 *   6. ADX >= trendAdx AND |slope| <  minSlope -> transition (unconfirmed)
 *   7. ADX <= rangeAdx                         -> range
 *   8. otherwise (ADX dead zone)               -> transition
 *
 * Every function is deterministic for deterministic input (no clock, no
 * randomness), fails closed on malformed input, and emits `unknown` with
 * confidence 0 + degradation reason codes — it never invents a state.
 * Default thresholds are baseline placeholders (ADR-0016): no tuning until
 * the P8/P9 validation gates exist.
 */
import {
  type Candle,
  type RegimeAssessment,
  type RegimeReasonCode,
  type RegimeState,
  TIMEFRAME_MS,
  normalizeRegimeAssessment,
} from "@fdbtrade/contracts";

import { adx } from "@/features/indicators";
import { atrFraction, trendSlopePips } from "@/features/structure";

/** Baseline classifier thresholds (NOT tuned — placeholders, ADR-0016). */
export interface RegimeClassifierConfig {
  /** Prior bars used for the volatility baseline (strictly before bar i). */
  volWindow: number;
  /** atrRatio >= this -> high_volatility. */
  highVolRatio: number;
  /** atrRatio <= this -> low_volatility. */
  lowVolRatio: number;
  /** ADX >= this -> trend evidence. */
  trendAdx: number;
  /** ADX <= this -> range evidence. */
  rangeAdx: number;
  /** |slope| in pips/bar >= this -> slope confirms trend. */
  minSlopePips: number;
}

export const DEFAULT_REGIME_CONFIG: RegimeClassifierConfig = Object.freeze({
  volWindow: 50,
  highVolRatio: 1.5,
  lowVolRatio: 0.6,
  trendAdx: 25,
  rangeAdx: 20,
  minSlopePips: 0.5,
});

/** Identity of this classifier; every assessment carries it. */
export const REGIME_CLASSIFIER_ID = "regime-rule-baseline";
export const REGIME_CLASSIFIER_VERSION = "1.0.0";

/** Aligned per-bar feature series consumed by the classifier. */
export interface RegimeFeatureSeries {
  /** Bar OPEN times, UTC, strictly ascending. */
  timestamps: readonly string[];
  adx: readonly (number | null)[];
  atrFraction: readonly (number | null)[];
  slopePips: readonly (number | null)[];
}

/** Feature-extraction options (periods only; thresholds live in config). */
export interface RegimeFeatureOptions {
  adxPeriod: number;
  atrPeriod: number;
  slopeWindow: number;
  /** Instrument pip size (metadata from the catalog — never a literal). */
  pip: number;
}

function assertValidConfig(config: RegimeClassifierConfig): void {
  if (!Number.isInteger(config.volWindow) || config.volWindow < 1) {
    throw new Error(`volWindow must be an integer >= 1: ${config.volWindow}`);
  }
  if (!Number.isFinite(config.highVolRatio) || config.highVolRatio <= 1) {
    throw new Error(`highVolRatio must be > 1: ${config.highVolRatio}`);
  }
  if (!Number.isFinite(config.lowVolRatio) || config.lowVolRatio <= 0 || config.lowVolRatio >= 1) {
    throw new Error(`lowVolRatio must be in (0,1): ${config.lowVolRatio}`);
  }
  if (!Number.isFinite(config.trendAdx) || config.trendAdx <= 0 || config.trendAdx >= 100) {
    throw new Error(`trendAdx must be in (0,100): ${config.trendAdx}`);
  }
  if (
    !Number.isFinite(config.rangeAdx) ||
    config.rangeAdx <= 0 ||
    config.rangeAdx >= config.trendAdx
  ) {
    throw new Error(`rangeAdx must be in (0,trendAdx): ${config.rangeAdx}`);
  }
  if (!Number.isFinite(config.minSlopePips) || config.minSlopePips < 0) {
    throw new Error(`minSlopePips must be >= 0: ${config.minSlopePips}`);
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Build the aligned feature series from canonical candles using the P03
 * primitives. Bar i uses bars [0..i] only — no future bars.
 */
export function regimeFeatureSeriesFromCandles(
  candles: readonly Candle[],
  options: RegimeFeatureOptions,
): RegimeFeatureSeries {
  const { adxPeriod, atrPeriod, slopeWindow, pip } = options;
  if (!Number.isInteger(adxPeriod) || adxPeriod < 1) {
    throw new Error(`adxPeriod must be an integer >= 1: ${adxPeriod}`);
  }
  if (!Number.isInteger(atrPeriod) || atrPeriod < 1) {
    throw new Error(`atrPeriod must be an integer >= 1: ${atrPeriod}`);
  }
  if (!Number.isInteger(slopeWindow) || slopeWindow < 2) {
    throw new Error(`slopeWindow must be an integer >= 2: ${slopeWindow}`);
  }
  if (!(pip > 0)) {
    throw new Error(`pip must be > 0: ${pip}`);
  }
  if (candles.length === 0) {
    return { timestamps: [], adx: [], atrFraction: [], slopePips: [] };
  }
  const timeframe = candles[0].timeframe;
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    if (c.timeframe !== timeframe) {
      throw new Error(`timeframe mismatch at bar ${i}: ${c.timeframe} != ${timeframe}`);
    }
    if (i > 0 && !(candles[i - 1].timestamp < c.timestamp)) {
      throw new Error(`candle timestamps must be strictly ascending at bar ${i}`);
    }
  }
  return {
    timestamps: candles.map((c) => c.timestamp),
    adx: adx(candles, adxPeriod),
    atrFraction: atrFraction(candles, atrPeriod),
    slopePips: trendSlopePips(
      candles.map((c) => c.close),
      slopeWindow,
      pip,
    ),
  };
}

/** Inputs recorded on every assessment (featureId -> value|null). */
type RegimeInputs = Record<string, number | null>;

const UTC_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function assessment(
  options: { instrument: string; timeframe: Candle["timeframe"] },
  classifierVersion: string,
  eventTimeUtc: string,
  state: RegimeState,
  confidence: number,
  reasonCodes: RegimeReasonCode[],
  inputs: RegimeInputs,
): RegimeAssessment {
  return normalizeRegimeAssessment({
    instrument: options.instrument,
    timeframe: options.timeframe,
    eventTimeUtc,
    state,
    confidence,
    reasonCodes,
    classifierId: REGIME_CLASSIFIER_ID,
    classifierVersion,
    inputs,
  });
}

/**
 * Classify a regime per bar. Deterministic for deterministic input;
 * bar i is computed from features at bars [0..i] only (the volatility
 * baseline uses strictly PRIOR bars). Output is aligned with the input.
 */
export function classifyRegimes(
  features: RegimeFeatureSeries,
  options: {
    instrument: string;
    timeframe: Candle["timeframe"];
    config?: RegimeClassifierConfig;
    classifierVersion?: string;
  },
): RegimeAssessment[] {
  const config = options.config ?? DEFAULT_REGIME_CONFIG;
  const classifierVersion = options.classifierVersion ?? REGIME_CLASSIFIER_VERSION;
  assertValidConfig(config);
  if (!options.instrument) {
    throw new Error("instrument is required");
  }
  if (!(options.timeframe in TIMEFRAME_MS)) {
    throw new Error(`timeframe must be a canonical timeframe: ${options.timeframe}`);
  }

  const { timestamps, adx: adxSeries, atrFraction: atrSeries, slopePips: slopeSeries } = features;
  const n = timestamps.length;
  if (adxSeries.length !== n || atrSeries.length !== n || slopeSeries.length !== n) {
    throw new Error("feature series must all have the same length as timestamps");
  }
  let prev = "";
  for (let i = 0; i < n; i += 1) {
    const ts = timestamps[i];
    if (!UTC_INSTANT_RE.test(ts)) {
      throw new Error(`timestamp must be a canonical UTC instant: ${ts}`);
    }
    if (ts <= prev) {
      throw new Error(`timestamps must be strictly ascending at index ${i}`);
    }
    prev = ts;
  }

  const out: RegimeAssessment[] = [];
  for (let i = 0; i < n; i += 1) {
    const adxValue = adxSeries[i];
    const atrValue = atrSeries[i];
    const slopeValue = slopeSeries[i];
    const inputs: RegimeInputs = {
      adx: adxValue,
      atr_fraction: atrValue,
      slope_pips: slopeValue,
      vol_ratio: null,
    };

    // Rule 1: missing required feature (includes warmup nulls).
    if (adxValue === null || atrValue === null || slopeValue === null) {
      out.push(
        assessment(options, classifierVersion, timestamps[i], "unknown", 0, ["missing_feature"], inputs),
      );
      continue;
    }

    // Rule 2: volatility baseline needs volWindow non-null prior values.
    let baselineSum = 0;
    let baselineCount = 0;
    for (let j = i - 1; j >= 0 && baselineCount < config.volWindow; j -= 1) {
      const v = atrSeries[j];
      if (v !== null) {
        baselineSum += v;
        baselineCount += 1;
      }
    }
    if (baselineCount < config.volWindow) {
      out.push(
        assessment(
          options,
          classifierVersion,
          timestamps[i],
          "unknown",
          0,
          ["insufficient_history", "vol_baseline_unavailable"],
          inputs,
        ),
      );
      continue;
    }
    const baseline = baselineSum / config.volWindow;
    if (!(baseline > 0)) {
      out.push(
        assessment(
          options,
          classifierVersion,
          timestamps[i],
          "unknown",
          0,
          ["missing_feature", "vol_baseline_unavailable"],
          inputs,
        ),
      );
      continue;
    }
    const volRatio = atrValue / baseline;
    inputs.vol_ratio = volRatio;

    // Rules 3-4: volatility extremes.
    if (volRatio >= config.highVolRatio) {
      out.push(
        assessment(
          options,
          classifierVersion,
          timestamps[i],
          "high_volatility",
          clamp01((volRatio - config.highVolRatio) / config.highVolRatio),
          ["vol_baseline_ready", "vol_expansion"],
          inputs,
        ),
      );
      continue;
    }
    if (volRatio <= config.lowVolRatio) {
      out.push(
        assessment(
          options,
          classifierVersion,
          timestamps[i],
          "low_volatility",
          clamp01((config.lowVolRatio - volRatio) / config.lowVolRatio),
          ["vol_baseline_ready", "vol_contraction"],
          inputs,
        ),
      );
      continue;
    }

    // Rules 5-7: trend / range by ADX with slope confirmation.
    const absSlope = Math.abs(slopeValue);
    if (adxValue >= config.trendAdx && absSlope >= config.minSlopePips) {
      out.push(
        assessment(
          options,
          classifierVersion,
          timestamps[i],
          "trend",
          clamp01((adxValue - config.trendAdx) / (100 - config.trendAdx)),
          ["adx_trend_evidence", "slope_confirms_trend"],
          inputs,
        ),
      );
      continue;
    }
    if (adxValue >= config.trendAdx) {
      out.push(
        assessment(
          options,
          classifierVersion,
          timestamps[i],
          "transition",
          0.5,
          ["adx_trend_evidence", "slope_conflicts_trend"],
          inputs,
        ),
      );
      continue;
    }
    if (adxValue <= config.rangeAdx) {
      out.push(
        assessment(
          options,
          classifierVersion,
          timestamps[i],
          "range",
          clamp01((config.rangeAdx - adxValue) / config.rangeAdx),
          ["adx_range_evidence"],
          inputs,
        ),
      );
      continue;
    }

    // Rule 8: ADX dead zone.
    out.push(
      assessment(options, classifierVersion, timestamps[i], "transition", 0.5, ["adx_dead_zone"], inputs),
    );
  }
  return out;
}