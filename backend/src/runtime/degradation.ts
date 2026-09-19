/**
 * Controlled degradation (M45, ADR-0034).
 *
 * Under resource or data pressure the runtime degrades EXPLICITLY rather
 * than failing silently: pressure levels move a monotone degradation scale
 * (`normal -> elevated -> conservative -> suspended`), and the decision is
 * fail-closed — an unknown or out-of-range input never lowers the level.
 *
 * Pressure inputs (all optional, all honest):
 * - queue backlog (jobs pending/running beyond the soft budget)
 * - heap usage ratio (process memory pressure)
 * - free-disk ratio (the runtime must not write into a full disk)
 * - data staleness (analysis inputs older than the freshness budget)
 *
 * Safety: degradation NEVER relaxes risk hard limits (they remain
 * authoritative, ADR-0022) and never enables execution. It only throttles
 * scheduling intensity and marks health.
 */

export const DEGRADATION_LEVELS = [
  "normal",
  "elevated",
  "conservative",
  "suspended",
] as const;
export type DegradationLevel = (typeof DEGRADATION_LEVELS)[number];

/** Frozen monotone ordering; index = severity. */
export const DEGRADATION_SEVERITY: Readonly<
  Record<DegradationLevel, number>
> = Object.freeze({
  normal: 0,
  elevated: 1,
  conservative: 2,
  suspended: 3,
});

export interface PressureInputs {
  /** Pending+running jobs beyond the soft budget drives queue pressure. */
  queueBacklog?: number;
  queueSoftLimit?: number;
  /** heapUsed / heapTotal, 0..1. */
  heapRatio?: number;
  /** free / total, 0..1 (LOW free space = HIGH pressure). */
  freeDiskRatio?: number;
  /** Age of the freshest analysis input, in ms. */
  dataStalenessMs?: number;
  stalenessBudgetMs?: number;
}

export interface PressureThresholds {
  queueSoftLimit: number;
  heapWarnRatio: number;
  heapSuspendRatio: number;
  freeDiskWarnRatio: number;
  freeDiskSuspendRatio: number;
  stalenessWarnMs: number;
  stalenessSuspendMs: number;
}

export const DEFAULT_PRESSURE_THRESHOLDS: PressureThresholds = Object.freeze({
  queueSoftLimit: 100,
  heapWarnRatio: 0.75,
  heapSuspendRatio: 0.92,
  freeDiskWarnRatio: 0.2,
  freeDiskSuspendRatio: 0.05,
  stalenessWarnMs: 10 * 60_000,
  stalenessSuspendMs: 60 * 60_000,
});

/** One named pressure signal. */
export interface PressureSignal {
  name: "queue" | "memory" | "disk" | "staleness";
  /** 0 none, 1 warn, 2 suspend. */
  level: 0 | 1 | 2;
  detail: string;
}

/** Evaluate the four pressure signals against explicit thresholds. */
export function evaluatePressure(
  inputs: PressureInputs,
  thresholds: PressureThresholds = DEFAULT_PRESSURE_THRESHOLDS,
): PressureSignal[] {
  const signals: PressureSignal[] = [];

  if (inputs.queueBacklog !== undefined) {
    const budget = inputs.queueSoftLimit ?? thresholds.queueSoftLimit;
    const backlog = inputs.queueBacklog;
    if (!Number.isFinite(backlog) || backlog < 0) {
      // Fail closed: unknown queue depth is treated as warn-level pressure.
      signals.push({ name: "queue", level: 1, detail: "queue_backlog_unknown" });
    } else {
      const level: 0 | 1 | 2 =
        backlog > budget ? 2 : backlog > budget * 0.5 ? 1 : 0;
      signals.push({ name: "queue", level, detail: `backlog=${backlog}` });
    }
  }

  if (inputs.heapRatio !== undefined) {
    const ratio = inputs.heapRatio;
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      signals.push({ name: "memory", level: 2, detail: "heap_ratio_invalid" });
    } else {
      const level: 0 | 1 | 2 =
        ratio >= thresholds.heapSuspendRatio ? 2 : ratio >= thresholds.heapWarnRatio ? 1 : 0;
      signals.push({ name: "memory", level, detail: `heapRatio=${ratio.toFixed(3)}` });
    }
  }

  if (inputs.freeDiskRatio !== undefined) {
    const ratio = inputs.freeDiskRatio;
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      // Fail closed: unknown free-disk state suspends scheduling.
      signals.push({ name: "disk", level: 2, detail: "free_disk_ratio_invalid" });
    } else {
      const level: 0 | 1 | 2 =
        ratio <= thresholds.freeDiskSuspendRatio ? 2 : ratio <= thresholds.freeDiskWarnRatio ? 1 : 0;
      signals.push({ name: "disk", level, detail: `freeDiskRatio=${ratio.toFixed(3)}` });
    }
  }

  if (inputs.dataStalenessMs !== undefined) {
    const budget = inputs.stalenessBudgetMs ?? thresholds.stalenessSuspendMs;
    const staleness = inputs.dataStalenessMs;
    if (!Number.isFinite(staleness) || staleness < 0) {
      signals.push({ name: "staleness", level: 1, detail: "staleness_unknown" });
    } else {
      const level: 0 | 1 | 2 = staleness > budget ? 2 : staleness > budget / 3 ? 1 : 0;
      signals.push({ name: "staleness", level, detail: `staleMs=${Math.round(staleness)}` });
    }
  }

  return signals;
}

/**
 * Map pressure-signal levels (0 none / 1 warn / 2 suspend) onto degradation
 * levels. A suspend-level signal means suspended; a warn means elevated
 * (full cycles continue, flagged); conservative is a distinct, explicitly
 * settable level in the frozen vocabulary (not derived from a single
 * signal). Highest active signal wins.
 */
const SIGNAL_LEVEL_TO_DEGRADATION: Readonly<Record<0 | 1 | 2, DegradationLevel>> =
  Object.freeze({ 0: "normal", 1: "elevated", 2: "suspended" });

export function degradationLevelFromSignals(
  signals: readonly PressureSignal[],
): DegradationLevel {
  let worst: 0 | 1 | 2 = 0;
  for (const signal of signals) {
    worst = Math.max(worst, signal.level) as 0 | 1 | 2;
  }
  return SIGNAL_LEVEL_TO_DEGRADATION[worst];
}

/**
 * One-shot degradation decision: pressure -> level. Pure; the scheduler
 * applies the level (skip ticks when suspended, note degradation in health).
 */
export function evaluateDegradation(
  inputs: PressureInputs,
  thresholds: PressureThresholds = DEFAULT_PRESSURE_THRESHOLDS,
): { level: DegradationLevel; signals: PressureSignal[] } {
  const signals = evaluatePressure(inputs, thresholds);
  return { level: degradationLevelFromSignals(signals), signals };
}

/**
 * Cycle-admission rule under a degradation level. Fail-safe: suspended
 * admits NOTHING, conservative admits only lightweight observation, elevated
 * and normal admit full cycles. This throttles scheduling intensity only —
 * it never bypasses risk hard limits (ADR-0022) and never enables execution.
 */
export function admitCycle(
  level: DegradationLevel,
): { admit: boolean; scope: "full" | "observation_only" | "none" } {
  switch (level) {
    case "normal":
      return { admit: true, scope: "full" };
    case "elevated":
      return { admit: true, scope: "full" };
    case "conservative":
      return { admit: true, scope: "observation_only" };
    case "suspended":
      return { admit: false, scope: "none" };
  }
}