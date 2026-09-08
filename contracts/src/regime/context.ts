/**
 * Multi-timeframe regime context contracts (P04-03).
 *
 * A regime context attaches higher-timeframe (1h/4h/1d) regime state to a
 * lower-timeframe assessment WITHOUT future leakage: a higher-timeframe
 * assessment is usable for a lower-timeframe event time only when that
 * HTF bar has CLOSED (bar open + timeframe duration <= event time).
 * Stale or missing HTF context degrades to `unknown` fail-closed — never
 * the latest known state (ADR-0016).
 */
import { z } from "zod";

import { timeframeSchema, utcInstantSchema } from "../marketdata/time";
import {
  regimeAssessmentSchema,
  regimeConfidenceSchema,
  regimeReasonCodeSchema,
  regimeStateSchema,
} from "./contract";

/** Effective higher-timeframe regime state for one timeframe. */
export const regimeContextEntrySchema = z
  .object({
    timeframe: timeframeSchema,
    /** Effective state: degraded to `unknown` when stale/missing. */
    state: regimeStateSchema,
    confidence: regimeConfidenceSchema,
    /** Open time of the highest closed HTF bar (null when none). */
    barOpenTimeUtc: utcInstantSchema.nullable(),
    /** Close time of that bar = open + timeframe duration (null when none). */
    closedAtUtc: utcInstantSchema.nullable(),
    /** True when the entry is degraded (stale or missing). */
    stale: z.boolean(),
    /** `context_ready` | `stale_context` | `missing_context`. */
    reasonCodes: z.array(regimeReasonCodeSchema).min(1),
  })
  .strict();

export type RegimeContextEntry = z.infer<typeof regimeContextEntrySchema>;

/** Context for one lower-timeframe event time, one entry per HTF. */
export const regimeContextSchema = z
  .object({
    /** The lower-timeframe event time the context was built for (UTC). */
    eventTimeUtc: utcInstantSchema,
    entries: z.array(regimeContextEntrySchema).min(1),
  })
  .strict()
  .refine(
    (ctx) => new Set(ctx.entries.map((e) => e.timeframe)).size === ctx.entries.length,
    { message: "context entries must have unique timeframes", path: ["entries"] },
  );

export type RegimeContext = z.infer<typeof regimeContextSchema>;

/** A lower-timeframe assessment with its higher-timeframe context attached. */
export const regimeContextualAssessmentSchema = z
  .object({
    assessment: regimeAssessmentSchema,
    context: regimeContextSchema,
  })
  .strict();

export type RegimeContextualAssessment = z.infer<typeof regimeContextualAssessmentSchema>;