/**
 * Multi-timeframe regime context (P04-03).
 *
 * Aggregates higher-timeframe regime assessments into lower-timeframe
 * context WITHOUT future leakage (ADR-0016):
 * - an HTF assessment is usable for an event time only when its bar has
 *   CLOSED: barOpen + TIMEFRAME_MS[tf] <= eventTime (an open bar's regime
 *   is not final and would leak intra-bar information);
 * - stale HTF data (closed bar older than maxStaleBars * timeframe)
 *   degrades to `unknown` with `stale_context` — fail closed;
 * - a timeframe with no assessments degrades to `unknown` with
 *   `missing_context`.
 *
 * Deterministic for deterministic input; all timestamps UTC (ADR-0004).
 * No execution, no strategy, no broker coupling.
 */
import {
  type RegimeAssessment,
  type RegimeContext,
  type RegimeContextEntry,
  type RegimeContextualAssessment,
  TIMEFRAME_MS,
  type Timeframe,
  utcInstantSchema,
} from "@fdbtrade/contracts";

/** Default higher timeframes for context (blueprint: 1h/4h with 1D context). */
export const HIGHER_TIMEFRAMES: readonly Timeframe[] = Object.freeze(["1h", "4h", "1d"]);

export interface RegimeContextConfig {
  higherTimeframes: readonly Timeframe[];
  /** Bars after a bar closed before its context counts as stale, per TF. */
  maxStaleBars: Partial<Record<Timeframe, number>>;
}

export const DEFAULT_CONTEXT_CONFIG: RegimeContextConfig = Object.freeze({
  higherTimeframes: HIGHER_TIMEFRAMES,
  maxStaleBars: Object.freeze({ "1h": 6, "4h": 6, "1d": 5 }),
});

const UTC_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function parseEventTime(eventTimeUtc: string): number {
  if (!UTC_INSTANT_RE.test(eventTimeUtc)) {
    throw new Error(`eventTimeUtc must be a canonical UTC instant: ${eventTimeUtc}`);
  }
  return Date.parse(eventTimeUtc);
}

function degradedEntry(
  timeframe: Timeframe,
  code: "missing_context" | "stale_context",
  closed?: RegimeAssessment,
): RegimeContextEntry {
  return {
    timeframe,
    state: "unknown",
    confidence: 0,
    barOpenTimeUtc: closed ? closed.eventTimeUtc : null,
    closedAtUtc: closed
      ? new Date(Date.parse(closed.eventTimeUtc) + TIMEFRAME_MS[timeframe]).toISOString()
      : null,
    stale: true,
    reasonCodes: [code],
  };
}

function validateSeries(timeframe: Timeframe, series: readonly RegimeAssessment[]): void {
  let prev = "";
  for (const a of series) {
    if (a.timeframe !== timeframe) {
      throw new Error(
        `assessment timeframe mismatch: expected ${timeframe}, got ${a.timeframe}`,
      );
    }
    const ms = Date.parse(a.eventTimeUtc);
    if (ms % TIMEFRAME_MS[timeframe] !== 0) {
      throw new Error(
        `assessment eventTime ${a.eventTimeUtc} is not aligned to the ${timeframe} grid`,
      );
    }
    if (a.eventTimeUtc <= prev) {
      throw new Error("HTF assessments must be strictly ascending by eventTimeUtc");
    }
    prev = a.eventTimeUtc;
  }
}

/**
 * Build the higher-timeframe regime context for one lower-timeframe event
 * time. Deterministic for deterministic input; fails closed on malformed
 * or misaligned input.
 */
export function buildRegimeContext(
  assessmentsByTimeframe: Readonly<Partial<Record<Timeframe, readonly RegimeAssessment[]>>>,
  eventTimeUtc: string,
  config: RegimeContextConfig = DEFAULT_CONTEXT_CONFIG,
): RegimeContext {
  const eventMs = parseEventTime(eventTimeUtc);
  utcInstantSchema.parse(eventTimeUtc);
  const entries: RegimeContextEntry[] = [];
  for (const timeframe of config.higherTimeframes) {
    const series = assessmentsByTimeframe[timeframe];
    if (!series || series.length === 0) {
      entries.push(degradedEntry(timeframe, "missing_context"));
      continue;
    }
    validateSeries(timeframe, series);
    const frameMs = TIMEFRAME_MS[timeframe];
    // Latest assessment whose bar has fully CLOSED at or before eventTime.
    let closed: RegimeAssessment | undefined;
    for (let i = series.length - 1; i >= 0; i -= 1) {
      const closeMs = Date.parse(series[i].eventTimeUtc) + frameMs;
      if (closeMs <= eventMs) {
        closed = series[i];
        break;
      }
    }
    if (!closed) {
      entries.push(degradedEntry(timeframe, "missing_context"));
      continue;
    }
    const closedAtMs = Date.parse(closed.eventTimeUtc) + frameMs;
    const maxStaleMs = (config.maxStaleBars[timeframe] ?? 6) * frameMs;
    if (eventMs - closedAtMs > maxStaleMs) {
      entries.push(degradedEntry(timeframe, "stale_context", closed));
      continue;
    }
    entries.push({
      timeframe,
      state: closed.state,
      confidence: closed.confidence,
      barOpenTimeUtc: closed.eventTimeUtc,
      closedAtUtc: new Date(closedAtMs).toISOString(),
      stale: false,
      reasonCodes: ["context_ready"],
    });
  }
  return { eventTimeUtc, entries };
}

/**
 * Attach higher-timeframe context to every lower-timeframe assessment.
 * LTF assessments must share one timeframe that is NOT among the context
 * timeframes, and be strictly ascending (fail closed otherwise).
 */
export function attachRegimeContext(
  ltfAssessments: readonly RegimeAssessment[],
  assessmentsByTimeframe: Readonly<Partial<Record<Timeframe, readonly RegimeAssessment[]>>>,
  config: RegimeContextConfig = DEFAULT_CONTEXT_CONFIG,
): RegimeContextualAssessment[] {
  let prev = "";
  let ltfTimeframe: Timeframe | null = null;
  for (const a of ltfAssessments) {
    if (ltfTimeframe === null) {
      ltfTimeframe = a.timeframe;
      if (config.higherTimeframes.includes(a.timeframe)) {
        throw new Error(
          `lower timeframe ${a.timeframe} must not appear in the context timeframes`,
        );
      }
    }
    if (a.timeframe !== ltfTimeframe) {
      throw new Error("LTF assessments must all share one timeframe");
    }
    if (a.eventTimeUtc <= prev) {
      throw new Error("LTF assessments must be strictly ascending by eventTimeUtc");
    }
    prev = a.eventTimeUtc;
  }
  return ltfAssessments.map((assessment) => ({
    assessment,
    context: buildRegimeContext(assessmentsByTimeframe, assessment.eventTimeUtc, config),
  }));
}