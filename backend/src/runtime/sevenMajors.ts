/**
 * M47 seven-major fixture runtime coverage.
 *
 * External pair ids stay explicit (`EUR_USD` etc.); domain contracts continue
 * to use canonical catalog ids (`EURUSD` etc.). Every pair owns its worker,
 * job store and cache, so a failed pair cannot poison another pair's state.
 *
 * Bounds and honesty rules:
 * - Per-pair caches are bounded (`SEVEN_MAJOR_CACHED_RANGES_PER_PAIR` ranges),
 *   so the whole slice has a fixed memory ceiling.
 * - Load shedding reuses the M45 degradation vocabulary (`evaluateDegradation`
 *   / `admitCycle`): a shed pair is explicitly `unavailable` with a reason and
 *   zero candles — data is never substituted, other pairs stay unaffected.
 * - Quarantine counts are MEASURED by the P02-03 quality gate for the pair's
 *   own series (never an invented zero).
 * - The projection contains no wall-clock timing or randomness: identical
 *   inputs produce byte-identical output, so a restart simply re-derives it
 *   (this module holds no durable state).
 *
 * Read-only fixture work. No execution authority, no order path anywhere.
 */
import type { HistoricalCandlesRequest, InstrumentId, MarketDataProvider } from "@fdbtrade/contracts";
import { getInstrument } from "@fdbtrade/contracts";

import { MarketDataCache } from "@/data/ingestion/cache";
import { JobStore, type JobClock } from "@/data/ingestion/jobs";
import { IngestionWorker, type SleepFn } from "@/data/ingestion/worker";
import { FixtureProvider } from "@/data/providers/fixture";
import {
  DEGRADATION_SEVERITY,
  admitCycle,
  evaluateDegradation,
  type DegradationLevel,
  type PressureInputs,
} from "@/runtime/degradation";

export const SEVEN_MAJOR_PAIRS = [
  "EUR_USD", "GBP_USD", "USD_JPY", "USD_CHF", "AUD_USD", "USD_CAD", "NZD_USD",
] as const;
export type SevenMajorPair = (typeof SEVEN_MAJOR_PAIRS)[number];

export interface SevenMajorConfig {
  pair: SevenMajorPair;
  canonicalInstrument: InstrumentId;
  baseCurrency: string;
  quoteCurrency: string;
  currencyCluster: "usd" | "jpy" | "chf" | "cad";
}

const canonicalFor = (pair: SevenMajorPair): InstrumentId => pair.replace("_", "") as InstrumentId;

export const SEVEN_MAJOR_CONFIG: readonly SevenMajorConfig[] = Object.freeze(
  SEVEN_MAJOR_PAIRS.map((pair) => {
    const instrument = getInstrument(canonicalFor(pair));
    return Object.freeze({
      pair,
      canonicalInstrument: instrument.id,
      baseCurrency: instrument.baseAsset,
      quoteCurrency: instrument.quoteAsset,
      currencyCluster: instrument.baseAsset === "USD" || instrument.quoteAsset === "USD"
        ? "usd"
        : instrument.quoteAsset.toLowerCase() as "jpy" | "chf" | "cad",
    });
  }),
);

export type MajorPairState = "fresh" | "stale" | "unavailable" | "quarantined";

export interface MajorPairProjection {
  pair: SevenMajorPair;
  canonicalInstrument: InstrumentId;
  providerId: string;
  providerPair: SevenMajorPair;
  state: MajorPairState;
  acceptedCandles: number;
  /** Rows quarantined by the P02-03 gate for this pair (measured, not assumed). */
  quarantinedRows: number;
  gaps: number;
  retries: number;
  error: string | null;
  provenance: "fixture";
}

export interface SevenMajorResources {
  configuredPairs: number;
  /** Pairs that produced real accepted data (fresh/stale/quarantined). */
  completedPairs: number;
  failedPairs: number;
  /** Failed pairs that were shed by degradation admission, not provider faults. */
  shedPairs: number;
  degradationLevel: DegradationLevel;
  /** Fixed cache ceiling across all pair workers (ranges per pair × pairs). */
  maxCachedRanges: number;
}

export interface SevenMajorReplayResult {
  pairs: readonly MajorPairProjection[];
  resources: SevenMajorResources;
}

/** Explicit shed reasons — a shed pair never receives substituted data. */
export const SEVEN_MAJOR_SHED_REASONS = Object.freeze({
  suspended: "cycle_not_admitted:suspended",
  observationOnly: "load_shed:observation_only",
} as const);

/** Bounded per-pair candle-range cache (current range + one backfill range). */
export const SEVEN_MAJOR_CACHED_RANGES_PER_PAIR = 2;

export interface SevenMajorReplayOptions {
  provider?: MarketDataProvider;
  clock?: JobClock;
  sleep?: SleepFn;
  /** Test-only deterministic fault injection. Never substitutes data. */
  failPairs?: readonly SevenMajorPair[];
  /** Measured pressure inputs (M45 degradation vocabulary). */
  pressure?: PressureInputs;
  /**
   * Explicit scheduler/operator degradation level. The effective level is the
   * MORE severe of this and the pressure-derived level, so a caller can raise
   * degradation but can never weaken the admission decision.
   */
  degradationLevel?: DegradationLevel;
  /**
   * Pairs kept under observation when admission is `observation_only`
   * (configured pair order is the priority order). Default 1: one pair keeps
   * observing while the remaining pairs are explicitly shed.
   */
  observationBudget?: number;
}

function assertSevenMajorRequest(request: HistoricalCandlesRequest): void {
  if (request.timeframe !== "1h") throw new Error("seven-major replay supports 1h only");
  if (Date.parse(request.startUtc) >= Date.parse(request.endUtc)) throw new Error("invalid replay range");
}

/**
 * Effective degradation level: the more severe of the measured pressure level
 * and any explicit operator/scheduler level. Monotone by construction — a
 * caller can raise degradation but never lower the admission decision.
 */
function effectiveLevel(options: SevenMajorReplayOptions): DegradationLevel {
  const derived = evaluateDegradation(options.pressure ?? {}).level;
  const explicit = options.degradationLevel;
  if (explicit === undefined) {
    return derived;
  }
  return DEGRADATION_SEVERITY[explicit] >= DEGRADATION_SEVERITY[derived] ? explicit : derived;
}

/** Pairs admitted under an admission scope; configured order = priority order. */
function admittedPairs(
  scope: "full" | "observation_only" | "none",
  options: SevenMajorReplayOptions,
): ReadonlySet<SevenMajorPair> {
  if (scope === "full") {
    return new Set<SevenMajorPair>(SEVEN_MAJOR_PAIRS);
  }
  if (scope === "none") {
    return new Set<SevenMajorPair>();
  }
  const budget = Math.max(1, Math.floor(options.observationBudget ?? 1));
  return new Set<SevenMajorPair>(SEVEN_MAJOR_PAIRS.slice(0, budget));
}

/**
 * Replay all configured majors independently. A failing or shed pair is
 * represented as unavailable with its explicit reason; successful pairs retain
 * real fixture output. Output order is fixed by `SEVEN_MAJOR_PAIRS`.
 */
export async function replaySevenMajors(
  request: Omit<HistoricalCandlesRequest, "instrument">,
  options: SevenMajorReplayOptions = {},
): Promise<SevenMajorReplayResult> {
  assertSevenMajorRequest({ ...request, instrument: "EURUSD" });
  const provider = options.provider ?? new FixtureProvider();
  const failed = new Set(options.failPairs ?? []);
  const level = effectiveLevel(options);
  const scope = admitCycle(level).scope;
  const admitted = admittedPairs(scope, options);
  const shedReason =
    scope === "none" ? SEVEN_MAJOR_SHED_REASONS.suspended : SEVEN_MAJOR_SHED_REASONS.observationOnly;

  const results = await Promise.all(
    SEVEN_MAJOR_CONFIG.map(async (config): Promise<MajorPairProjection> => {
      const base = {
        pair: config.pair,
        canonicalInstrument: config.canonicalInstrument,
        providerId: provider.id,
        providerPair: config.pair,
        provenance: "fixture" as const,
      };
      if (!admitted.has(config.pair)) {
        // Bounded load shedding: explicit unavailable row, zero candles, no
        // substitution, and no effect on the pairs that stay admitted.
        return {
          ...base, state: "unavailable", acceptedCandles: 0, quarantinedRows: 0,
          gaps: 0, retries: 0, error: shedReason,
        };
      }
      if (failed.has(config.pair)) {
        return {
          ...base, state: "unavailable", acceptedCandles: 0, quarantinedRows: 0,
          gaps: 0, retries: 0, error: "fault_injected_pair_unavailable",
        };
      }
      const worker = new IngestionWorker(provider, {
        cache: new MarketDataCache({ maxEntries: SEVEN_MAJOR_CACHED_RANGES_PER_PAIR }),
        jobStore: new JobStore(options.clock),
        clock: options.clock,
        sleep: options.sleep ?? (async () => {}),
      });
      const outcome = await worker.ingestCandles({
        ...request,
        instrument: config.canonicalInstrument,
      });
      if (outcome.job.status !== "succeeded") {
        return {
          ...base, state: "unavailable", acceptedCandles: 0, quarantinedRows: 0, gaps: 0,
          retries: outcome.job.attempts, error: outcome.job.failureReason ?? "ingestion_failed",
        };
      }
      const quarantinedRows = outcome.quarantined.length;
      const state: MajorPairState =
        quarantinedRows > 0 ? "quarantined" : outcome.gaps.length > 0 ? "stale" : "fresh";
      return {
        ...base, state, acceptedCandles: outcome.candles.length, quarantinedRows,
        gaps: outcome.gaps.length, retries: Math.max(0, outcome.job.attempts - 1), error: null,
      };
    }),
  );
  const completedPairs = results.filter((row) => row.state !== "unavailable").length;
  const shedPairs = results.filter(
    (row) =>
      row.error === SEVEN_MAJOR_SHED_REASONS.suspended ||
      row.error === SEVEN_MAJOR_SHED_REASONS.observationOnly,
  ).length;
  return {
    pairs: results,
    resources: {
      configuredPairs: SEVEN_MAJOR_CONFIG.length,
      completedPairs,
      failedPairs: SEVEN_MAJOR_CONFIG.length - completedPairs,
      shedPairs,
      degradationLevel: level,
      maxCachedRanges: SEVEN_MAJOR_CONFIG.length * SEVEN_MAJOR_CACHED_RANGES_PER_PAIR,
    },
  };
}
