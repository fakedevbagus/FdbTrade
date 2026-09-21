/**
 * Private signal pipeline — deterministic evaluation for the UI layer
 * (P07-01, ADR-0018 contracts; ADR-0003 boundaries).
 *
 * Runs the north-star loop READ-ONLY over the fixture provider for one
 * explicit `asOfUtc` closed bar:
 *
 *   fixture candles (1h) -> regime assessments + HTF context ->
 *   P5 baseline strategy evaluations -> ensemble votes -> cost/edge gate ->
 *   calibration stamp -> ranking -> dashboard snapshot.
 *
 * Determinism rules:
 * - NO wall clock, NO randomness: `asOfUtc` is an explicit closed input;
 *   the same request always yields a byte-identical snapshot (freshness
 *   derives from `asOfUtc` exactly like P06-05).
 * - All timestamps UTC (ADR-0004). `asOfUtc` must be aligned to the 1h grid.
 * - Fail closed: malformed input, session gap or insufficient history
 *   surfaces as a structured per-instrument error; the dashboard still
 *   renders the rest (errors never fabricate data).
 * - No execution layer, no order intent anywhere (ADR-0005). The output is
 *   output is a read-only intelligence snapshot.
 */
import {
  type Candle,
  type EnsembleDecision,
  type EnsembleVote,
  type InstrumentId,
  type Quote,
  type RegimeAssessment,
  type RegimeContext,
  SIGNAL_REASON_CODES,
  TIMEFRAME_MS,
  type Timeframe,
  getInstrument,
  getSchedule,
  utcInstantSchema,
} from "@fdbtrade/contracts";
import rawFixtureAnchors from "@fdbtrade/contracts/src/data/fixtureProvider.json";

import { FixtureProvider } from "@/data/providers/fixture";
import { SEVEN_MAJOR_CONFIG, type SevenMajorPair } from "@/runtime/sevenMajors";
import {
  DEFAULT_CALIBRATION_CONFIG,
  stampCalibration,
} from "@/ensemble/calibration";
import { gateDecision, computeEdgeReport, type EdgeGateConfig } from "@/ensemble/edgeGate";
import { evaluateEnsemble } from "@/ensemble/weighting";
import { rankDecisions, type RankRow } from "@/ensemble/ranking";
import { buildRegimeContext } from "@/regime/context";
import {
  classifyRegimes,
  regimeFeatureSeriesFromCandles,
} from "@/regime/classifier";
import { BASELINE_STRATEGIES } from "@/strategy/all";

import { DASHBOARD_WEIGHT_TABLE } from "./weights";

export const SIGNAL_PIPELINE_ID = "private-signal-pipeline";
export const SIGNAL_PIPELINE_VERSION = "1.0.0";

/** Trading timeframe the UI pipeline evaluates (blueprint intraday core). */
export const PIPELINE_TIMEFRAME: Timeframe = "1h";

/** 1h bars fetched for indicator warmup (max baseline minHistoryBars). */
const HISTORY_BARS = 300;

/** Fixture provider health is deterministic; the id is contract data. */
const FIXTURE_PROVIDER_ID: string = new FixtureProvider().id;

// ---------------------------------------------------------------------------
// Fixture anchor access (data, not literals — P02-02 fixtureProvider.json)
// ---------------------------------------------------------------------------

interface FixtureAnchor {
  basePrice: number;
  pipVolatility: number;
  typicalSpreadPips: number;
}

const fixtureAnchors: Readonly<Record<string, FixtureAnchor>> = Object.freeze(
  rawFixtureAnchors.anchors as Record<string, FixtureAnchor>,
);

function fixtureAnchor(instrumentId: InstrumentId): FixtureAnchor {
  const anchor = fixtureAnchors[instrumentId];
  if (!anchor) {
    throw new Error(`no fixture anchor for ${instrumentId}`);
  }
  return anchor;
}

/** Edge-gate cost inputs (per-instrument data; slippage/multiple are the
 *  P06-03 documented placeholders — NOT observed production costs). */
function edgeGateConfigFor(instrumentId: InstrumentId): EdgeGateConfig {
  return {
    spreadPips: fixtureAnchor(instrumentId).typicalSpreadPips,
    slippagePips: 0.3,
    minEdgeCostMultiple: 2,
    pipSize: getInstrument(instrumentId).precision.pip,
  };
}

// ---------------------------------------------------------------------------
// Output contracts (typed rows the API/UI consume)
// ---------------------------------------------------------------------------

export interface SignalPipelineRequest {
  /** Open time (UTC) of the last CLOSED 1h bar the snapshot is built from. */
  asOfUtc: string;
  /** Instruments to evaluate (default: the full canonical universe). */
  instruments?: readonly InstrumentId[];
}

/** Per-instrument market/regime/freshness row for the command center. */
export interface InstrumentOverviewRow {
  instrument: InstrumentId;
  /** Last closed 1h bar open time used by the evaluation. */
  eventTimeUtc: string;
  /** Fixture quote at asOfUtc (synthetic — labeled as such downstream). */
  quote: Quote | null;
  /** 1h change in pips (close - prev close), null when history too short. */
  changePips: number | null;
  /** Effective HTF regime state (1d > 4h > 1h precedence, fail closed). */
  regimeState: string;
  /** Regime confidence in [0,1] of the resolved entry (0 when unknown). */
  regimeConfidence: number;
  /** True when the resolved regime entry is degraded (stale/missing). */
  regimeDegraded: boolean;
  /** Explicit configured pair name at the provider boundary, e.g. EUR_USD. */
  configuredPair: SevenMajorPair;
  /** This M47 snapshot is offline deterministic fixture data. */
  provenance: "fixture";
  /** True when the instrument's last closed bar is behind asOfUtc. */
  stale: boolean;
  /** Whole 1h bars the last closed bar is behind asOfUtc (0 = current). */
  barsBehind: number;
}

/** Active-signal row: a live (non-expired) canonical signal with context. */
export interface ActiveSignalRow {
  signalId: string;
  instrument: InstrumentId;
  timeframe: Timeframe;
  eventTimeUtc: string;
  expiresAtUtc: string;
  direction: "long" | "short";
  strategyId: string;
  referencePrice: number;
  stopLoss: number;
  takeProfit: number | null;
  confidence: number;
  reasonCodes: readonly string[];
  snapshotHash: string;
  decisionId: string;
  action: EnsembleDecision["action"];
}

/** Top-opportunity row (derived — derivation labeled via rank reason codes). */
export interface TopOpportunityRow {
  rank: number;
  instrument: InstrumentId;
  action: EnsembleDecision["action"];
  score: number;
  netEdgePips: number;
  confidence: number;
  reasonCodes: readonly string[];
  decisionId: string;
}

/** Data freshness summary across the evaluated instruments. */
export interface FreshnessSummary {
  asOfUtc: string;
  freshInstruments: number;
  staleInstruments: number;
  totalInstruments: number;
}

/** The full dashboard snapshot (P07-01 command center contract). */
export interface DashboardSnapshot {
  asOfUtc: string;
  pipelineId: string;
  pipelineVersion: string;
  providerId: string;
  generatedFrom: "fixture";
  overview: readonly InstrumentOverviewRow[];
  activeSignals: readonly ActiveSignalRow[];
  topOpportunities: readonly TopOpportunityRow[];
  freshness: FreshnessSummary;
  /** Placeholder until the P11 risk engine exists — always null now. */
  portfolioHeat: {
    heatPct: number | null;
    capPct: number | null;
    placeholder: true;
  };
  /** Per-instrument failures (fail closed — never silently dropped). */
  errors: readonly { instrument: InstrumentId; error: string }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UTC_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function assertAsOf(asOfUtc: string): void {
  utcInstantSchema.parse(asOfUtc);
  if (!UTC_MS_RE.test(asOfUtc)) {
    throw new Error(`asOfUtc must be a canonical UTC instant: ${asOfUtc}`);
  }
  if (Date.parse(asOfUtc) % TIMEFRAME_MS[PIPELINE_TIMEFRAME] !== 0) {
    throw new Error(
      `asOfUtc must be aligned to the ${PIPELINE_TIMEFRAME} grid: ${asOfUtc}`,
    );
  }
}

/** Whole 1h bars between two instants (>= 0). */
function barsBetween(fromUtc: string, toUtc: string): number {
  return Math.round(
    (Date.parse(toUtc) - Date.parse(fromUtc)) / TIMEFRAME_MS[PIPELINE_TIMEFRAME],
  );
}

/**
 * Latest fully-closed 1h bar at or before `asOfUtc` inside the instrument's
 * session. Returns null when none exists in the lookback window (weekend /
 * session gap — the row is then stale, fail closed).
 */
async function latestClosedBar(
  provider: FixtureProvider,
  instrumentId: InstrumentId,
  asOfUtc: string,
): Promise<{ barOpenUtc: string; barsBehind: number } | null> {
  const horizonMs = 3 * 24 * 60 * 60_000;
  const startUtc = new Date(Date.parse(asOfUtc) - horizonMs).toISOString();
  const candles = await provider.getHistoricalCandles({
    instrument: instrumentId,
    timeframe: PIPELINE_TIMEFRAME,
    startUtc,
    endUtc: asOfUtc,
  });
  const last = candles[candles.length - 1];
  if (!last) {
    return null;
  }
  // The fetch returns bars with open < endUtc; the last bar may be the asOf
  // bar itself (still OPEN at asOf). Drop it when it has not fully closed.
  const closeMs = Date.parse(last.timestamp) + TIMEFRAME_MS[PIPELINE_TIMEFRAME];
  if (closeMs > Date.parse(asOfUtc)) {
    const trimmed = candles.slice(0, -1);
    const t = trimmed[trimmed.length - 1];
    return t
      ? { barOpenUtc: t.timestamp, barsBehind: barsBetween(t.timestamp, asOfUtc) }
      : null;
  }
  return {
    barOpenUtc: last.timestamp,
    barsBehind: barsBetween(last.timestamp, asOfUtc),
  };
}

/** Fetch up to `HISTORY_BARS` closed 1h candles ending at `barOpenUtc`. */
async function historyEndingAt(
  provider: FixtureProvider,
  instrumentId: InstrumentId,
  barOpenUtc: string,
): Promise<readonly Candle[]> {
  const endExclusive = new Date(Date.parse(barOpenUtc) + 1).toISOString();
  const startUtc = new Date(
    Date.parse(barOpenUtc) - HISTORY_BARS * TIMEFRAME_MS[PIPELINE_TIMEFRAME],
  ).toISOString();
  const candles = await provider.getHistoricalCandles({
    instrument: instrumentId,
    timeframe: PIPELINE_TIMEFRAME,
    startUtc,
    endUtc: endExclusive,
  });
  // No look-ahead: the evaluation window ends at the closed bar's open.
  return candles.filter((c) => Date.parse(c.timestamp) <= Date.parse(barOpenUtc));
}

/** Classify regime assessments for one timeframe ending at `barOpenUtc`. */
async function regimeAssessmentsFor(
  provider: FixtureProvider,
  instrumentId: InstrumentId,
  timeframe: Timeframe,
  barOpenUtc: string,
  pipelineHistory: readonly Candle[],
): Promise<readonly RegimeAssessment[]> {
  const pip = getInstrument(instrumentId).precision.pip;
  const options = { adxPeriod: 14, atrPeriod: 14, slopeWindow: 20, pip };
  if (timeframe === PIPELINE_TIMEFRAME) {
    const features = regimeFeatureSeriesFromCandles(pipelineHistory, options);
    return classifyRegimes(features, { instrument: instrumentId, timeframe });
  }
  const barsNeeded = 120;
  const frameMs = TIMEFRAME_MS[timeframe];
  const endExclusive = new Date(Date.parse(barOpenUtc) + 1).toISOString();
  const startUtc = new Date(Date.parse(barOpenUtc) - barsNeeded * frameMs).toISOString();
  const candles = (
    await provider.getHistoricalCandles({
      instrument: instrumentId,
      timeframe,
      startUtc,
      endUtc: endExclusive,
    })
  ).filter((c) => Date.parse(c.timestamp) <= Date.parse(barOpenUtc));
  const features = regimeFeatureSeriesFromCandles(candles, options);
  return classifyRegimes(features, { instrument: instrumentId, timeframe });
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/** Effective regime for the overview row (1d > 4h > 1h, fail closed). */
function resolveOverviewRegime(context: RegimeContext): {
  state: string;
  confidence: number;
  degraded: boolean;
} {
  for (const tf of ["1d", "4h", "1h"] as const) {
    const entry = context.entries.find(
      (e) => e.timeframe === tf && !e.stale && e.state !== "unknown",
    );
    if (entry) {
      return { state: entry.state, confidence: entry.confidence, degraded: false };
    }
  }
  return { state: "unknown", confidence: 0, degraded: true };
}

type InstrumentResult =
  | {
      ok: true;
      instrument: InstrumentId;
      decision: EnsembleDecision;
      netEdgePips: number;
      overview: InstrumentOverviewRow;
      activeSignals: ActiveSignalRow[];
    }
  | {
      ok: false;
      instrument: InstrumentId;
      error: string;
      overview: InstrumentOverviewRow;
      activeSignals: ActiveSignalRow[];
    };

/**
 * Evaluate one instrument for the dashboard at `asOfUtc`. Deterministic
 * apart from fixture-provider reads. Fail closed per instrument: an error
 * produces a stale overview row, no decision, no signals.
 */
async function evaluateInstrument(
  provider: FixtureProvider,
  instrumentId: InstrumentId,
  asOfUtc: string,
): Promise<InstrumentResult> {
  const meta = getInstrument(instrumentId);
  const configuredPair = SEVEN_MAJOR_CONFIG.find(
    (entry) => entry.canonicalInstrument === instrumentId,
  )?.pair;
  if (!configuredPair) {
    throw new Error(`instrument is outside the configured seven-major runtime: ${instrumentId}`);
  }

  const closed = await latestClosedBar(provider, instrumentId, asOfUtc);
  const quoteResp = await provider
    .getQuotes({ instruments: [instrumentId], atUtc: asOfUtc })
    .catch(() => null);
  const quote = quoteResp ? (quoteResp[0] ?? null) : null;

  const fail = (
    eventTimeUtc: string,
    barsBehind: number,
    error: string,
  ): InstrumentResult => ({
    ok: false,
    instrument: instrumentId,
    error,
    overview: {
      instrument: instrumentId,
      eventTimeUtc,
      quote,
      changePips: null,
      regimeState: "unknown",
      regimeConfidence: 0,
      regimeDegraded: true,
      configuredPair,
      provenance: "fixture",
      stale: true,
      barsBehind,
    },
    activeSignals: [],
  });

  if (!closed) {
    return fail("", -1, "no closed bar at asOfUtc (session gap or weekend)");
  }
  const { barOpenUtc, barsBehind } = closed;

  const history = await historyEndingAt(provider, instrumentId, barOpenUtc);
  if (history.length < 30) {
    return fail(
      barOpenUtc,
      barsBehind,
      `insufficient closed history (${history.length} bars)`,
    );
  }

  // Regime: 1h series from the evaluation history + HTF 4h/1d assessments.
  const [ltfAssessments, htf4h, htf1d] = await Promise.all([
    regimeAssessmentsFor(provider, instrumentId, PIPELINE_TIMEFRAME, barOpenUtc, history),
    regimeAssessmentsFor(provider, instrumentId, "4h", barOpenUtc, history),
    regimeAssessmentsFor(provider, instrumentId, "1d", barOpenUtc, history),
  ]);
  const context = buildRegimeContext({ "4h": htf4h, "1d": htf1d }, barOpenUtc);
  void ltfAssessments;

  // Strategy evaluations over the closed snapshot.
  const snapshot = {
    instrument: {
      id: instrumentId,
      pip: meta.precision.pip,
      digits: meta.precision.digits,
    },
    timeframe: PIPELINE_TIMEFRAME,
    eventTimeUtc: barOpenUtc,
    candles: [...history],
    regimeContext: context,
    contextTimeframes: ["4h", "1d"] as Timeframe[],
  };
  const votes: EnsembleVote[] = [];
  for (const strategy of BASELINE_STRATEGIES) {
    const evaluation = strategy.evaluate(snapshot);
    // Evaluation codes are loose strings (interface contract); the vote
    // contract requires the frozen signal enum — unknown codes drop (fail
    // closed to the known-evidence subset, never invented codes).
    const validCodes = new Set(SIGNAL_REASON_CODES as readonly string[]);
    const reasonCodes = evaluation.reasonCodes.filter((c) =>
      validCodes.has(c),
    ) as EnsembleVote["reasonCodes"];
    votes.push({
      strategyId: strategy.id,
      strategyVersion: strategy.version,
      configVersion: strategy.configVersion,
      instrument: instrumentId,
      timeframe: PIPELINE_TIMEFRAME,
      eventTimeUtc: barOpenUtc,
      stance: evaluation.signal === null ? "abstain" : evaluation.signal.direction,
      confidence: evaluation.signal === null ? 0.4 : evaluation.signal.confidence,
      reasonCodes: reasonCodes.length > 0 ? reasonCodes : ["no_setup"],
      signal: evaluation.signal,
    });
  }
  votes.sort((a, b) => (a.strategyId < b.strategyId ? -1 : 1));

  // Ensemble -> cost/edge gate -> calibration stamp (pure P6 layers).
  const baseDecision = evaluateEnsemble({
    instrument: instrumentId,
    timeframe: PIPELINE_TIMEFRAME,
    eventTimeUtc: barOpenUtc,
    votes,
    regimeContext: context,
    weightTable: DASHBOARD_WEIGHT_TABLE,
    correlationPenalty: {
      pairCorrelations: {},
      penaltyFactor: 1,
      source: "dashboard-default-no-penalty",
    },
    componentVersions: {
      [SIGNAL_PIPELINE_ID]: SIGNAL_PIPELINE_VERSION,
    },
  });
  const gated = gateDecision(baseDecision, edgeGateConfigFor(instrumentId));
  const stamped = stampCalibration(gated.decision, [], DEFAULT_CALIBRATION_CONFIG);

  // Overview change: last close vs previous close, in pips.
  const last = history[history.length - 1];
  const prev = history.length >= 2 ? history[history.length - 2] : null;
  const changePips =
    prev === null ? null : (last.close - prev.close) / meta.precision.pip;

  const resolved = resolveOverviewRegime(context);

  // Active signals: live canonical signals from directional votes whose
  // decision entered and whose signal has not expired at asOfUtc.
  const activeSignals: ActiveSignalRow[] = [];
  for (const vote of stamped.votes) {
    if (
      vote.signal !== null &&
      stamped.action !== "wait" &&
      Date.parse(vote.signal.expiresAtUtc) > Date.parse(asOfUtc)
    ) {
      activeSignals.push({
        signalId: vote.signal.signalId,
        instrument: vote.signal.instrument,
        timeframe: vote.signal.timeframe,
        eventTimeUtc: vote.signal.eventTimeUtc,
        expiresAtUtc: vote.signal.expiresAtUtc,
        direction: vote.signal.direction,
        strategyId: vote.signal.strategyId,
        referencePrice: vote.signal.referencePrice,
        stopLoss: vote.signal.stopLoss,
        takeProfit: vote.signal.takeProfit,
        confidence: vote.signal.confidence,
        reasonCodes: vote.signal.reasonCodes,
        snapshotHash: vote.signal.snapshotHash,
        decisionId: stamped.decisionId,
        action: stamped.action,
      });
    }
  }
  activeSignals.sort((a, b) => (a.signalId < b.signalId ? -1 : 1));

  return {
    ok: true,
    instrument: instrumentId,
    decision: stamped,
    netEdgePips: gated.report?.netEdgePips ?? 0,
    overview: {
      instrument: instrumentId,
      eventTimeUtc: barOpenUtc,
      quote,
      changePips: changePips === null ? null : Number(changePips.toFixed(2)),
      regimeState: resolved.state,
      regimeConfidence: resolved.confidence,
      regimeDegraded: resolved.degraded,
      configuredPair,
      provenance: "fixture",
      stale: barsBehind > 0,
      barsBehind,
    },
    activeSignals,
  };
}

/**
 * Build the dashboard snapshot at `asOfUtc`. Deterministic for a
 * deterministic request: same input, same output, byte-identical.
 */
export async function buildDashboardSnapshot(
  request: SignalPipelineRequest,
): Promise<DashboardSnapshot> {
  assertAsOf(request.asOfUtc);
  const instruments = request.instruments ?? SEVEN_MAJOR_CONFIG.map((entry) => entry.canonicalInstrument);
  const provider = new FixtureProvider();

  const results = await Promise.all(
    instruments.map((id) => evaluateInstrument(provider, id, request.asOfUtc)),
  );

  // Ranking (P06-05) over the successful decisions. WAIT rows are never
  // dropped — they simply do not qualify as opportunities.
  const okResults = results.filter(
    (r): r is Extract<typeof r, { ok: true }> => r.ok,
  );
  const candidates = okResults.map((r) => ({
    decision: r.decision,
    netEdgePips: r.netEdgePips,
    correlations: {} as Record<string, number>,
  }));
  const rankRows: RankRow[] = rankDecisions(candidates, request.asOfUtc);
  const decisionById = new Map(okResults.map((r) => [r.decision.decisionId, r]));

  const overview = results.map((r) => r.overview);
  const errors = results
    .filter((r) => !r.ok)
    .map((r) => ({ instrument: r.instrument, error: (r as { error: string }).error }));

  const activeSignals = results
    .flatMap((r) => r.activeSignals)
    .sort((a, b) => (a.signalId < b.signalId ? -1 : 1));

  const topOpportunities: TopOpportunityRow[] = rankRows
    .filter((row) => row.action !== "wait")
    .map((row) => {
      const result = decisionById.get(row.decisionId);
      return {
        rank: row.rank,
        instrument: row.instrument as InstrumentId,
        action: row.action,
        score: row.score,
        netEdgePips: result?.netEdgePips ?? 0,
        confidence: result?.decision.confidence ?? 0,
        reasonCodes: result?.decision.reasonCodes ?? [],
        decisionId: row.decisionId,
      };
    });

  const staleCount = overview.filter((r) => r.stale).length;

  return {
    asOfUtc: request.asOfUtc,
    pipelineId: SIGNAL_PIPELINE_ID,
    pipelineVersion: SIGNAL_PIPELINE_VERSION,
    providerId: FIXTURE_PROVIDER_ID,
    generatedFrom: "fixture",
    overview,
    activeSignals,
    topOpportunities,
    freshness: {
      asOfUtc: request.asOfUtc,
      freshInstruments: overview.length - staleCount,
      staleInstruments: staleCount,
      totalInstruments: overview.length,
    },
    portfolioHeat: { heatPct: null, capPct: null, placeholder: true },
    errors,
  };
}

// ---------------------------------------------------------------------------
// Scanner view (P07-02) — ranked rows + deterministic filter application
// ---------------------------------------------------------------------------

import {
  applyScannerQuery,
  type ScannerQuery,
  type ScannerRow,
  scannerQuerySchema,
  scannerQueryToParams,
} from "./scanner";

/** Response contract of the scanner API. */
export interface ScannerView {
  asOfUtc: string;
  pipelineId: string;
  pipelineVersion: string;
  /** The validated filter query this view was built from. */
  query: ScannerQuery;
  /** Canonical URL params for `query` (reproducible scanner state). */
  canonicalParams: string;
  /** Filtered + sorted rows (deterministic order). */
  rows: ScannerRow[];
  /** Row count before filtering (auditability of what was excluded). */
  totalRows: number;
  /** Per-instrument failures surfaced (fail closed — visible, not silent). */
  errors: readonly { instrument: InstrumentId; error: string }[];
}

/**
 * Build the scanner view: evaluate the pipeline at `asOfUtc` (the same
 * deterministic snapshot as P07-01), expose the ranked enter rows, then
 * apply the validated scanner query. WAIT decisions are filterable but not
 * listed as opportunities (they carry no edge). Identical inputs ->
 * byte-identical output.
 */
export async function buildScannerView(
  request: SignalPipelineRequest,
  queryInput: ScannerQuery,
): Promise<ScannerView> {
  const query = scannerQuerySchema.parse(queryInput);
  const snapshot = await buildDashboardSnapshot(request);
  const rows: ScannerRow[] = snapshot.topOpportunities.map((top) => {
    const overview = snapshot.overview.find((o) => o.instrument === top.instrument);
    return {
      decisionId: top.decisionId,
      instrument: top.instrument,
      timeframe: PIPELINE_TIMEFRAME,
      action: top.action,
      direction:
        top.action === "enter_long" ? "long" : top.action === "enter_short" ? "short" : null,
      score: top.score,
      netEdgePips: top.netEdgePips,
      confidence: top.confidence,
      regimeState: overview?.regimeState ?? "unknown",
      regimeDegraded: overview?.regimeDegraded ?? true,
      fresh: overview ? !overview.stale : false,
      barsBehind: overview?.barsBehind ?? -1,
      signalAgeBars: overview?.barsBehind ?? -1,
      rank: top.rank,
    };
  });
  const filtered = applyScannerQuery(rows, query);
  return {
    asOfUtc: snapshot.asOfUtc,
    pipelineId: SIGNAL_PIPELINE_ID,
    pipelineVersion: SIGNAL_PIPELINE_VERSION,
    query,
    canonicalParams: scannerQueryToParams(query).toString(),
    rows: filtered,
    totalRows: rows.length,
    errors: snapshot.errors,
  };
}

// ---------------------------------------------------------------------------
// Signal detail view (P07-03)
// ---------------------------------------------------------------------------

/** One strategy vote with its signal levels (display form). */
export interface DetailVoteRow {
  strategyId: string;
  strategyVersion: string;
  configVersion: string;
  stance: "long" | "short" | "abstain";
  confidence: number;
  reasonCodes: readonly string[];
  signal: {
    signalId: string;
    direction: "long" | "short";
    entryType: string;
    entryPrice: number | null;
    referencePrice: number;
    stopLoss: number;
    takeProfit: number | null;
    expiresAtUtc: string;
    confidence: number;
    reasonCodes: readonly string[];
    snapshotHash: string;
    /** Exact feature inputs used (lineage; consumed by the chart panel). */
    inputs: Record<string, number | boolean | null>;
  } | null;
}

/** Full detail view: every displayed claim maps to stored fields. */
export interface SignalDetailView {
  asOfUtc: string;
  found: true;
  decision: {
    decisionId: string;
    instrument: InstrumentId;
    timeframe: Timeframe;
    eventTimeUtc: string;
    action: EnsembleDecision["action"];
    direction: "long" | "short" | null;
    dominantStrategyId: string | null;
    confidence: number;
    reasonCodes: readonly string[];
    decisionHash: string;
    weightsVersion: string;
    componentVersions: Readonly<Record<string, string>>;
    confidenceComponents: {
      voteAgreement: number;
      weightedAgreement: number;
      regimeAlignment: number;
      correlationPenalty: number;
      calibration: {
        empiricalHitRate: number | null;
        sampleSize: number;
        uncertaintyFlags: readonly string[];
      };
    };
  };
  votes: DetailVoteRow[];
  regimeContext: RegimeContext;
  edge: {
    expectedMovePips: number | null;
    stopDistancePips: number | null;
    costFloorPips: number | null;
    netEdgePips: number | null;
    passes: boolean | null;
    /** Derived analytics are labeled as such (acceptance criterion). */
    derived: true;
  };
  dataQuality: {
    fresh: boolean;
    barsBehind: number;
    degradedContext: boolean;
    derived: true;
  };
  /** Strategy performance context: explicitly no data yet (P12 owns it). */
  performanceContext: {
    hasBacktestStats: false;
    note: string;
  };
  expiry: {
    /** Earliest live-signal expiry for an enter decision (null on WAIT). */
    expiresAtUtc: string | null;
  };
}

/**
 * Build the full signal-detail view for one decisionId at `asOfUtc`.
 * Re-evaluates the pipeline deterministically (same inputs -> same detail)
 * and locates the requested decision among the results. Unknown or
 * un-evaluable decisions return null (the caller maps that to 404).
 */
export async function buildSignalDetail(
  request: SignalPipelineRequest,
  decisionId: string,
): Promise<SignalDetailView | null> {
  assertAsOf(request.asOfUtc);
  const instruments = request.instruments ?? SEVEN_MAJOR_CONFIG.map((entry) => entry.canonicalInstrument);
  const provider = new FixtureProvider();

  const results = await Promise.all(
    instruments.map((id) => evaluateInstrument(provider, id, request.asOfUtc)),
  );
  const target = results.find(
    (r) => r.ok && r.decision.decisionId === decisionId,
  );
  if (!target || !target.ok) {
    return null;
  }
  const decision = target.decision;

  // Edge report recomputed from the same deterministic inputs.
  const report = computeEdgeReport(decision, edgeGateConfigFor(decision.instrument));

  const liveExpiries = decision.votes
    .filter(
      (v) =>
        v.signal !== null &&
        decision.action !== "wait" &&
        Date.parse(v.signal.expiresAtUtc) > Date.parse(request.asOfUtc),
    )
    .map((v) => (v as { signal: { expiresAtUtc: string } }).signal.expiresAtUtc)
    .sort();

  return {
    asOfUtc: request.asOfUtc,
    found: true,
    decision: {
      decisionId: decision.decisionId,
      instrument: decision.instrument,
      timeframe: decision.timeframe,
      eventTimeUtc: decision.eventTimeUtc,
      action: decision.action,
      direction: decision.direction,
      dominantStrategyId: decision.dominantStrategyId,
      confidence: decision.confidence,
      reasonCodes: decision.reasonCodes,
      decisionHash: decision.decisionHash,
      weightsVersion: decision.weightsVersion,
      componentVersions: decision.componentVersions,
      confidenceComponents: decision.confidenceComponents,
    },
    votes: decision.votes.map((v) => ({
      strategyId: v.strategyId,
      strategyVersion: v.strategyVersion,
      configVersion: v.configVersion,
      stance: v.stance,
      confidence: v.confidence,
      reasonCodes: v.reasonCodes,
      signal: v.signal,
    })),
    regimeContext: decision.regimeContext,
    edge: {
      expectedMovePips: report?.expectedMovePips ?? null,
      stopDistancePips: report?.stopDistancePips ?? null,
      costFloorPips: report?.costFloorPips ?? null,
      netEdgePips: report?.netEdgePips ?? null,
      passes: report?.passes ?? null,
      derived: true,
    },
    dataQuality: {
      fresh: !target.overview.stale,
      barsBehind: target.overview.barsBehind,
      degradedContext: target.overview.regimeDegraded,
      derived: true,
    },
    performanceContext: {
      hasBacktestStats: false,
      note: "No per-strategy backtest statistics exist yet; they arrive with the Backtest (P8) and Analytics (P12) phases. Nothing here is fabricated.",
    },
    expiry: {
      expiresAtUtc: liveExpiries.length > 0 ? liveExpiries[0] : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Chart view (P07-04) — market bars + signal overlays for one decision
// ---------------------------------------------------------------------------

/** One chart bar (display form; UTC open time, OHLC from the fixture). */
export interface ChartBar {
  openTimeUtc: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Signal marker pinned to a bar open time (coordinate = market time). */
export interface ChartMarker {
  /** Which bar the marker sits on (openTimeUtc of that bar). */
  atUtc: string;
  kind: "signal";
  label: string;
  decisionId: string;
  direction: "long" | "short";
}

/** Horizontal price overlays anchored to stored signal levels. */
export interface ChartLevels {
  entryPrice: number | null;
  referencePrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
}

/** Feature/context panel rows (feature inputs of the dominant vote). */
export interface ChartFeatureRow {
  featureId: string;
  value: number | boolean | null;
}

export interface SignalChartView {
  asOfUtc: string;
  found: true;
  instrument: InstrumentId;
  timeframe: Timeframe;
  /** Last closed bars ending at the decision bar (UTC open times). */
  bars: ChartBar[];
  markers: ChartMarker[];
  levels: ChartLevels;
  /** True when the decision bar is behind asOfUtc (visibly stale). */
  stale: boolean;
  barsBehind: number;
  /** Dominant vote's signal inputs (feature context panel). */
  features: ChartFeatureRow[];
  /** Regime state per context timeframe for the panel. */
  regimeContext: RegimeContext;
}

const CHART_BARS = 120;

/**
 * Build the chart view for one decisionId: the last closed 1h bars ending
 * at the decision bar, the signal marker pinned to that bar's open time,
 * the entry/SL/TP overlays from the stored dominant-signal levels, and the
 * dominant vote's feature inputs for the context panel. Deterministic for
 * deterministic inputs; null when the decisionId is unknown at asOfUtc.
 */
export async function buildSignalChart(
  request: SignalPipelineRequest,
  decisionId: string,
): Promise<SignalChartView | null> {
  assertAsOf(request.asOfUtc);
  const provider = new FixtureProvider();
  const instruments = request.instruments ?? SEVEN_MAJOR_CONFIG.map((entry) => entry.canonicalInstrument);

  for (const instrumentId of instruments) {
    const closed = await latestClosedBar(provider, instrumentId, request.asOfUtc);
    if (!closed) {
      continue;
    }
    const decisionPrefix = `ens_${instrumentId}_`;
    if (!decisionId.startsWith(decisionPrefix)) {
      continue;
    }
    const history = await historyEndingAt(provider, instrumentId, closed.barOpenUtc);
    const detail = await buildSignalDetail({ ...request, instruments: [instrumentId] }, decisionId);
    if (detail === null) {
      continue;
    }
    const bars: ChartBar[] = history.slice(-CHART_BARS).map((c) => ({
      openTimeUtc: c.timestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    const dominantVote = detail.votes.find(
      (v) => v.strategyId === detail.decision.dominantStrategyId && v.signal !== null,
    );
    const signal = dominantVote?.signal ?? null;
    const markers: ChartMarker[] =
      signal !== null && detail.decision.direction !== null
        ? [
            {
              atUtc: detail.decision.eventTimeUtc,
              kind: "signal",
              label: detail.decision.action,
              decisionId: detail.decision.decisionId,
              direction: detail.decision.direction,
            },
          ]
        : [];
    const features: ChartFeatureRow[] =
      signal !== null
        ? Object.keys(signal.inputs)
            .sort()
            .map((featureId) => ({ featureId, value: signal.inputs[featureId] }))
        : [];
    return {
      asOfUtc: request.asOfUtc,
      found: true,
      instrument: instrumentId,
      timeframe: PIPELINE_TIMEFRAME,
      bars,
      markers,
      levels: {
        entryPrice: signal?.entryPrice ?? null,
        referencePrice: signal?.referencePrice ?? null,
        stopLoss: signal?.stopLoss ?? null,
        takeProfit: signal?.takeProfit ?? null,
      },
      stale: detail.dataQuality.barsBehind > 0,
      barsBehind: detail.dataQuality.barsBehind,
      features,
      regimeContext: detail.regimeContext,
    };
  }
  return null;
}
