/**
 * Regime diagnostics contracts (P04-04).
 *
 * A pure read model over a series of regime assessments: state
 * distribution, transition counts, episode persistence and deterministic
 * quality flags — the research dashboard/API inspect regime states and
 * anomalies through this contract (ADR-0016). Diagnostics mutate nothing.
 */
import { z } from "zod";

import { instrumentIdSchema } from "../marketdata/instrument";
import { timeframeSchema, utcInstantSchema } from "../marketdata/time";
import { regimeStateSchema } from "./contract";

/** Deterministic quality-flag codes (sorted output order). */
export const REGIME_QUALITY_FLAG_CODES = [
  "empty_window",
  "high_unknown_share",
  "low_confidence",
  "regime_churn",
  "single_state_window",
  "stale_tail",
] as const;
export type RegimeQualityFlagCode = (typeof REGIME_QUALITY_FLAG_CODES)[number];

export const regimeQualityFlagSchema = z
  .object({
    code: z.enum(REGIME_QUALITY_FLAG_CODES),
    detail: z.string().min(1),
  })
  .strict();

export type RegimeQualityFlag = z.infer<typeof regimeQualityFlagSchema>;

/** Persistence stats for one state: runs of consecutive bars. */
export const regimeEpisodeStatsSchema = z
  .object({
    /** Number of distinct runs (episodes) of this state. */
    episodes: z.number().int().nonnegative(),
    /** Total bars in this state. */
    bars: z.number().int().nonnegative(),
    /** bars / episodes (null when episodes = 0). */
    meanBars: z.number().nonnegative().nullable(),
    /** Longest run length. */
    maxBars: z.number().int().nonnegative(),
  })
  .strict();

export type RegimeEpisodeStats = z.infer<typeof regimeEpisodeStatsSchema>;

/** Aggregated count of one observed state transition (from != to). */
export const regimeTransitionCountSchema = z
  .object({
    from: regimeStateSchema,
    to: regimeStateSchema,
    count: z.number().int().positive(),
  })
  .strict()
  .refine((t) => t.from !== t.to, {
    message: "transitions must change state",
    path: ["to"],
  });

export type RegimeTransitionCount = z.infer<typeof regimeTransitionCountSchema>;

/** The episode still open at the end of the window (null when empty). */
export const regimeCurrentEpisodeSchema = z
  .object({
    state: regimeStateSchema,
    bars: z.number().int().positive(),
    /** Bar-open time (UTC) of the first bar of the current episode. */
    sinceTimeUtc: utcInstantSchema,
  })
  .strict();

export type RegimeCurrentEpisode = z.infer<typeof regimeCurrentEpisodeSchema>;

export const regimeDiagnosticsSchema = z
  .object({
    instrument: instrumentIdSchema,
    timeframe: timeframeSchema,
    /** First/last assessment event times (null when the window is empty). */
    fromTimeUtc: utcInstantSchema.nullable(),
    toTimeUtc: utcInstantSchema.nullable(),
    bars: z.number().int().nonnegative(),
    /** Bar count per state (all canonical states, zeros included). */
    counts: z.record(regimeStateSchema, z.number().int().nonnegative()),
    /** counts / bars (0 when bars = 0). */
    shares: z.record(regimeStateSchema, z.number().min(0).max(1)),
    transitions: z.array(regimeTransitionCountSchema),
    totalTransitions: z.number().int().nonnegative(),
    /** Episode persistence stats per state (all canonical states). */
    episodes: z.record(regimeStateSchema, regimeEpisodeStatsSchema),
    currentEpisode: regimeCurrentEpisodeSchema.nullable(),
    /** Mean assessment confidence over the window (null when empty). */
    meanConfidence: z.number().min(0).max(1).nullable(),
    qualityFlags: z.array(regimeQualityFlagSchema),
  })
  .strict()
  .refine((d) => Object.values(d.counts).reduce((a, b) => a + b, 0) === d.bars, {
    message: "state counts must sum to bars",
    path: ["counts"],
  });

export type RegimeDiagnostics = z.infer<typeof regimeDiagnosticsSchema>;