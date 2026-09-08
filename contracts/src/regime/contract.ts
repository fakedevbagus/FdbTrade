/**
 * Regime contract (P04-01).
 *
 * Canonical regime states shared by strategies, analytics and the research
 * dashboard. Degraded states (`unknown`, `transition`) are first-class: a
 * regime assessment must ALWAYS be expressible, even when features are
 * missing — fail closed into `unknown` with reason codes, never invent a
 * state.
 *
 * Semantics (frozen here, reused by the P04-02 classifier):
 * - `eventTimeUtc` is the bar OPEN time in UTC (`CANDLE_TIMESTAMP_SEMANTICS`);
 *   the assessment describes the regime as of that bar close, computed from
 *   bars [0..i] only (no look-ahead — proven by tests, not asserted).
 * - `confidence` is a classifier-certainty score in [0,1] — NEVER a win
 *   probability and never a profit guarantee (blueprint non-negotiables).
 * - `unknown` requires confidence 0 AND at least one degradation reason
 *   code; non-unknown states must not carry degradation reason codes.
 */
import { z } from "zod";

import { instrumentIdSchema } from "../marketdata/instrument";
import { timeframeSchema, utcInstantSchema } from "../marketdata/time";
import { featureVersionSchema } from "../feature/definition";

/** Canonical regime states (frozen set; extension requires a new ADR). */
export const REGIME_STATES = [
  "trend",
  "range",
  "high_volatility",
  "low_volatility",
  "transition",
  "unknown",
] as const;
export type RegimeState = (typeof REGIME_STATES)[number];
export const regimeStateSchema = z.enum(REGIME_STATES);

/**
 * Reason codes: machine-readable evidence for (or degradation of) an
 * assessment. Sorted lexicographically and deduplicated on the wire.
 */
export const REGIME_REASON_CODES = [
  "adx_dead_zone",
  "adx_range_evidence",
  "adx_trend_evidence",
  "context_ready",
  "insufficient_history",
  "missing_context",
  "missing_feature",
  "slope_confirms_trend",
  "slope_conflicts_trend",
  "stale_context",
  "vol_baseline_ready",
  "vol_baseline_unavailable",
  "vol_contraction",
  "vol_expansion",
] as const;
export type RegimeReasonCode = (typeof REGIME_REASON_CODES)[number];
export const regimeReasonCodeSchema = z.enum(REGIME_REASON_CODES);

/**
 * Degradation reason codes: only valid on an `unknown` assessment. Any
 * assessment carrying one of these MUST be `unknown` (fail closed).
 */
export const DEGRADATION_REASON_CODES = [
  "insufficient_history",
  "missing_context",
  "missing_feature",
  "stale_context",
] as const;
export type DegradationReasonCode = (typeof DEGRADATION_REASON_CODES)[number];

/** Confidence in [0,1] — classifier certainty, never a win probability. */
export const regimeConfidenceSchema = z.number().min(0).max(1);

/** Feature values the assessment was derived from (featureId -> value|null). */
export const regimeInputsSchema = z.record(z.string().min(1), z.number().nullable());

export const regimeAssessmentSchema = z
  .object({
    instrument: instrumentIdSchema,
    timeframe: timeframeSchema,
    /** Bar OPEN time in UTC the assessment is anchored to. */
    eventTimeUtc: utcInstantSchema,
    state: regimeStateSchema,
    confidence: regimeConfidenceSchema,
    /** Sorted, unique, non-empty reason codes. */
    reasonCodes: z.array(regimeReasonCodeSchema).min(1),
    /** Stable classifier identity (e.g. `regime-rule-baseline`). */
    classifierId: z.string().min(1),
    /** Semver of the classifier that produced this assessment. */
    classifierVersion: featureVersionSchema,
    /** Feature values used (null = unavailable/warmup). */
    inputs: regimeInputsSchema,
  })
  .strict()
  .refine(
    (a) =>
      a.reasonCodes.every((code, i) => i === 0 || code > a.reasonCodes[i - 1]) &&
      new Set(a.reasonCodes).size === a.reasonCodes.length,
    { message: "reasonCodes must be sorted and unique", path: ["reasonCodes"] },
  )
  .refine((a) => a.state !== "unknown" || a.confidence === 0, {
    message: "unknown state requires confidence 0",
    path: ["confidence"],
  })
  .refine(
    (a) =>
      a.state !== "unknown" ||
      a.reasonCodes.some((code) => (DEGRADATION_REASON_CODES as readonly string[]).includes(code)),
    { message: "unknown state requires a degradation reason code", path: ["reasonCodes"] },
  )
  .refine(
    (a) =>
      a.state === "unknown" ||
      !a.reasonCodes.some((code) => (DEGRADATION_REASON_CODES as readonly string[]).includes(code)),
    { message: "degradation reason codes are only valid on unknown", path: ["reasonCodes"] },
  );

export type RegimeAssessment = z.infer<typeof regimeAssessmentSchema>;

/** Normalize + validate a raw assessment (sorts/dedupes reason codes first). */
export function normalizeRegimeAssessment(
  raw: Omit<RegimeAssessment, "reasonCodes"> & { reasonCodes: RegimeReasonCode[] },
): RegimeAssessment {
  const reasonCodes = Array.from(new Set(raw.reasonCodes)).sort();
  return regimeAssessmentSchema.parse({ ...raw, reasonCodes });
}

/** True when the assessment is degraded (fail-closed `unknown`). */
export function isDegradedAssessment(assessment: RegimeAssessment): boolean {
  return assessment.state === "unknown";
}
