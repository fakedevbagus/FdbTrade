/**
 * Portfolio intelligence engine (P18-04, ADR-0032 section 4).
 *
 * Optimizes SIGNAL SELECTION at portfolio level. Frozen semantics:
 * - SUBORDINATION: the selector ranks and filters candidates; it NEVER
 *   sizes positions, never bypasses and never weakens the P11 hard risk
 *   limits. Every hard-limit denial (heat, daily loss, spread, count,
 *   capacity, redundancy) is applied BEFORE scoring and each rejection
 *   carries an explicit reason code (explain each rejection).
 * - EXPECTED EDGE: candidates are scored by `expectedEdgeR` (expected R
 *   multiple net of costs — a MODEL ESTIMATE, never a guaranteed profit).
 * - CORRELATION/REDUNDANCY: pairwise correlation penalties reduce the
 *   score of correlated candidates; pairs above `maxCorrelated` cannot
 *   both be selected (the skip is explicit, never silent).
 * - HEAT/REGIME/CAPACITY: current portfolio heat fraction, regime label
 *   and per-instrument capacity are inputs to the deterministic selector;
 *   they cap but never inflate.
 * - SELECTION: greedy by adjusted score within constraints (deterministic;
 *   acceptance: no unconstrained optimizer). Ties broken by candidateId.
 * - Deterministic; UTC; no clock/random/broker access (ADR-0003/0004/0005).
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";
import { advHash16, advRound6 } from "./util";

export const PORTFOLIO_INTEL_ID = "portfolio-intelligence-engine";
export const PORTFOLIO_INTEL_VERSION = "1.0.0";

export class PortfolioIntelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortfolioIntelError";
  }
}

/** Machine-readable rejection reason codes (frozen; sorted). */
export const PORTFOLIO_REJECT_CODES = [
  "portfolio_capacity_exceeded", // instrument concurrent cap reached
  "portfolio_correlated_skip", // a higher-ranked correlated pick already selected
  "portfolio_daily_loss_breach", // daily loss stop reached
  "portfolio_duplicate_instrument_direction", // same instrument+direction picked
  "portfolio_expected_edge_negative", // expected edge below the minimum
  "portfolio_heat_breach", // projected heat would breach the cap
  "portfolio_max_positions", // max concurrent positions reached
  "portfolio_redundant_strategy", // same strategy+instrument+direction open
  "portfolio_spread_exceeded", // current spread above the allowed max
] as const;
export type PortfolioRejectCode = (typeof PORTFOLIO_REJECT_CODES)[number];
export const portfolioRejectCodeSchema = z.enum(PORTFOLIO_REJECT_CODES);


/** One candidate signal offered to the selector. */
export const portfolioCandidateSchema = z
  .object({
    /** Candidate identity (e.g. P05 signalId or ensemble decisionId). */
    candidateId: z.string().min(4),
    instrument: z.string().min(2),
    direction: z.enum(["long", "short"]),
    strategyId: z.string().min(2),
    /** Expected edge in R multiples NET of costs (estimate, not promise). */
    expectedEdgeR: z.number().finite(),
    /** Current spread at decision time, pips. */
    spreadPips: z.number().finite().nonnegative(),
    /** Planned risk fraction of equity for THIS candidate. */
    plannedRiskFraction: z.number().finite().positive().lte(0.05),
  })
  .strict();
export type PortfolioCandidate = z.infer<typeof portfolioCandidateSchema>;

/** Open-position context the selector must respect. */
export const portfolioOpenPositionSchema = z
  .object({
    positionId: z.string().min(1),
    instrument: z.string().min(2),
    direction: z.enum(["long", "short"]),
    strategyId: z.string().min(2),
    /** Planned stop risk as a fraction of equity. */
    riskFraction: z.number().finite().nonnegative(),
  })
  .strict();
export type PortfolioOpenPosition = z.infer<typeof portfolioOpenPositionSchema>;

/** Correlation matrix entry: two distinct instruments and a correlation. */
export const instrumentCorrelationSchema = z
  .object({
    instrumentA: z.string().min(2),
    instrumentB: z.string().min(2),
    /** Pearson-style correlation in [-1, 1]. */
    correlation: z.number().finite().min(-1).max(1),
  })
  .strict()
  .refine((c) => c.instrumentA !== c.instrumentB, {
    message: "instrumentA and instrumentB must differ",
    path: ["instrumentB"],
  });
export type InstrumentCorrelation = z.infer<typeof instrumentCorrelationSchema>;

/** Regime context input (P04 regime state label). */
export const portfolioRegimeContextSchema = z
  .object({
    /** P04 regime state for the trading universe context. */
    regimeState: z.string().min(2),
    /** Regime labels per candidate instrument (optional override). */
    perInstrument: z.record(z.string().min(2), z.string().min(2)),
  })
  .strict();
export type PortfolioRegimeContext = z.infer<typeof portfolioRegimeContextSchema>;

/** Versioned selector configuration (data, not literals). */
export const portfolioSelectorConfigSchema = z
  .object({
    configVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    /** Hard cap: projected portfolio heat fraction (P11 semantics). */
    maxHeatFraction: z.number().finite().gt(0).lte(0.1),
    /** Hard cap: max concurrent open positions (P11). */
    maxOpenPositions: z.number().int().min(1).max(100),
    /** Hard cap: daily loss stop fraction (P11). */
    maxDailyLossFraction: z.number().finite().gt(0).lte(0.1),
    /** Realized daily loss so far, fraction of day-start equity. */
    currentDailyLossFraction: z.number().finite().nonnegative(),
    /** Max spread allowed at selection time, pips. */
    maxSpreadPips: z.number().finite().positive(),
    /** Max concurrent positions per instrument (capacity). */
    maxPerInstrument: z.number().int().min(1).max(20),
    /** Correlation above which two candidates cannot BOTH be selected. */
    maxCorrelated: z.number().finite().min(-1).max(1),
    /** |correlation| penalty weight applied to the adjusted score. */
    correlationPenaltyWeight: z.number().finite().min(0).max(1),
    /** Minimum expected edge (R) to consider a candidate at all. */
    minExpectedEdgeR: z.number().finite(),
    /** Current portfolio heat fraction of the OPEN positions. */
    currentHeatFraction: z.number().finite().nonnegative(),
  })
  .strict()
  .refine((c) => c.currentDailyLossFraction <= c.maxDailyLossFraction, {
    message: "currentDailyLossFraction already at/above the daily stop (fail closed)",
    path: ["currentDailyLossFraction"],
  })
  .refine((c) => c.currentHeatFraction <= c.maxHeatFraction, {
    message: "currentHeatFraction already breaches the heat cap (fail closed)",
    path: ["currentHeatFraction"],
  });
export type PortfolioSelectorConfig = z.infer<typeof portfolioSelectorConfigSchema>;

/** One ranked candidate: original score, penalty, adjusted score. */
export const portfolioRankEntrySchema = z
  .object({
    candidateId: z.string().min(4),
    strategyId: z.string().min(2),
    instrument: z.string().min(2),
    direction: z.enum(["long", "short"]),
    expectedEdgeR: z.number().finite(),
    correlationPenalty: z.number().finite().min(0),
    adjustedScoreR: z.number().finite(),
  })
  .strict();
export type PortfolioRankEntry = z.infer<typeof portfolioRankEntrySchema>;

/** One rejection with its hard-limit or greedy reason code. */
export const portfolioRejectionSchema = z
  .object({
    candidateId: z.string().min(4),
    rejectCode: portfolioRejectCodeSchema,
    detail: z.string().min(1),
  })
  .strict();
export type PortfolioRejection = z.infer<typeof portfolioRejectionSchema>;

/**
 * Full portfolio selection result: selected candidates, rank table,
 * rejections (each with an explicit reason code) and the heat projection.
 */
export const portfolioDecisionSchema = z
  .object({
    decisionId: z.string().regex(/^pidec_[0-9a-f]{16}$/),
    /** UTC instant the portfolio decision was rendered. */
    decidedAtUtc: utcInstantSchema,
    configVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    /** Regime state the decision was rendered under (context visibility). */
    regimeState: z.string().min(2),
    selected: z.array(portfolioRankEntrySchema),
    rankTable: z.array(portfolioRankEntrySchema),
    rejections: z.array(portfolioRejectionSchema),
    /** Projected heat fraction including selected candidates. */
    projectedHeatFraction: z.number().finite().nonnegative(),
  })
  .strict();
export type PortfolioDecision = z.infer<typeof portfolioDecisionSchema>;

/**
 * Select the portfolio from candidates under the hard constraints.
 *
 * Deterministic algorithm (frozen):
 * 1. HARD FILTERS first (fail-closed, before any scoring): spread cap,
 *    min expected edge, open-position count, instrument capacity, redundant
 *    strategy+instrument+direction. Each denial -> explicit rejection.
 * 2. SCORE: adjustedScoreR = expectedEdgeR - penalty where penalty =
 *    correlationPenaltyWeight * max|corr| with already-selected picks.
 * 3. GREEDY SELECTION by descending adjustedScoreR (ties by candidateId):
 *    projected heat must stay <= cap; duplicate instrument+direction skips;
 *    correlation with a selected pick above `maxCorrelated` rejects with
 *    `portfolio_correlated_skip` (visible, never silent).
 * 4. The selector NEVER sizes positions and NEVER relaxes a cap — the P11
 *    risk engine re-checks everything downstream (subordination).
 */
export function selectPortfolio(input: {
  candidates: readonly PortfolioCandidate[];
  openPositions: readonly PortfolioOpenPosition[];
  correlations: readonly InstrumentCorrelation[];
  config: PortfolioSelectorConfig;
  regime: PortfolioRegimeContext;
  decidedAtUtc: string;
}): PortfolioDecision {
  const candidates = input.candidates.map((c) => portfolioCandidateSchema.parse(c));
  const open = input.openPositions.map((p) => portfolioOpenPositionSchema.parse(p));
  const config = portfolioSelectorConfigSchema.parse(input.config);
  const regime = portfolioRegimeContextSchema.parse(input.regime);
  const decidedAtUtc = utcInstantSchema.parse(input.decidedAtUtc);

  const ids = new Set(candidates.map((c) => c.candidateId));
  if (ids.size !== candidates.length) {
    throw new PortfolioIntelError("candidateIds must be unique");
  }

  const corr = new Map<string, number>();
  for (const e of input.correlations) {
    const ce = instrumentCorrelationSchema.parse(e);
    corr.set(`${ce.instrumentA}|${ce.instrumentB}`, ce.correlation);
    corr.set(`${ce.instrumentB}|${ce.instrumentA}`, ce.correlation);
  }
  const corrBetween = (a: string, b: string): number => corr.get(`${a}|${b}`) ?? 0;

  const rejections: PortfolioRejection[] = [];
  const rankTable: PortfolioRankEntry[] = [];
  const survivors: PortfolioCandidate[] = [];

  for (const c of candidates) {
    if (c.spreadPips > config.maxSpreadPips) {
      rejections.push({
        candidateId: c.candidateId,
        rejectCode: "portfolio_spread_exceeded",
        detail: `spread ${c.spreadPips} > max ${config.maxSpreadPips}`,
      });
      continue;
    }
    if (c.expectedEdgeR < config.minExpectedEdgeR) {
      rejections.push({
        candidateId: c.candidateId,
        rejectCode: "portfolio_expected_edge_negative",
        detail: `edge ${c.expectedEdgeR} < min ${config.minExpectedEdgeR}`,
      });
      continue;
    }
    if (open.length >= config.maxOpenPositions) {
      rejections.push({
        candidateId: c.candidateId,
        rejectCode: "portfolio_max_positions",
        detail: `open positions ${open.length} >= cap ${config.maxOpenPositions}`,
      });
      continue;
    }
    const perInstrument = open.filter((p) => p.instrument === c.instrument).length;
    if (perInstrument >= config.maxPerInstrument) {
      rejections.push({
        candidateId: c.candidateId,
        rejectCode: "portfolio_capacity_exceeded",
        detail: `${c.instrument} at capacity ${perInstrument}/${config.maxPerInstrument}`,
      });
      continue;
    }
    if (
      open.some(
        (p) =>
          p.instrument === c.instrument &&
          p.direction === c.direction &&
          p.strategyId === c.strategyId,
      )
    ) {
      rejections.push({
        candidateId: c.candidateId,
        rejectCode: "portfolio_redundant_strategy",
        detail: `strategy ${c.strategyId} already open on ${c.instrument} ${c.direction}`,
      });
      continue;
    }
    survivors.push(c);
  }


/** One rejection with its hard-limit or greedy reason code. */

  const selected: PortfolioRankEntry[] = [];
  let projectedHeat = config.currentHeatFraction;
  const pickedInstruments = new Map<string, number>();
  for (const p of open) {
    pickedInstruments.set(p.instrument, (pickedInstruments.get(p.instrument) ?? 0) + 1);
  }
  const chosenInstrumentDirection = new Set<string>();
  for (const p of open) chosenInstrumentDirection.add(`${p.instrument}|${p.direction}`);
  const remaining = new Map<string, PortfolioCandidate>(
    survivors.map((c) => [c.candidateId, c]),
  );

  for (;;) {
    let bestId: string | null = null;
    let bestScore = 0;
    let bestPenalty = 0;
    for (const c of remaining.values()) {
      let maxAbs = 0;
      for (const s of selected) {
        maxAbs = Math.max(maxAbs, Math.abs(corrBetween(c.instrument, s.instrument)));
      }
      const penalty = advRound6(config.correlationPenaltyWeight * maxAbs);
      const score = advRound6(c.expectedEdgeR - penalty);
      if (
        bestId === null ||
        score > bestScore ||
        (score === bestScore && c.candidateId < bestId)
      ) {
        bestId = c.candidateId;
        bestScore = score;
        bestPenalty = penalty;
      }
    }
    if (bestId === null) break;
    const c = remaining.get(bestId);
    if (c === undefined) break;
    rankTable.push({
      candidateId: c.candidateId,
      strategyId: c.strategyId,
      instrument: c.instrument,
      direction: c.direction,
      expectedEdgeR: c.expectedEdgeR,
      correlationPenalty: bestPenalty,
      adjustedScoreR: bestScore,
    });
    remaining.delete(bestId);

    if (open.length + selected.length >= config.maxOpenPositions) {
      rejections.push({
        candidateId: c.candidateId,
        rejectCode: "portfolio_max_positions",
        detail: `selection cap ${config.maxOpenPositions} reached`,
      });
      continue;
    }
    const perInst = pickedInstruments.get(c.instrument) ?? 0;
    if (perInst >= config.maxPerInstrument) {
      rejections.push({
        candidateId: c.candidateId,
        rejectCode: "portfolio_capacity_exceeded",
        detail: `${c.instrument} at capacity ${perInst}/${config.maxPerInstrument}`,
      });
      continue;
    }
    if (chosenInstrumentDirection.has(`${c.instrument}|${c.direction}`)) {
      rejections.push({
        candidateId: c.candidateId,
        rejectCode: "portfolio_duplicate_instrument_direction",
        detail: `${c.instrument} ${c.direction} already selected/open`,
      });
      continue;
    }
    const heatWithCandidate = advRound6(projectedHeat + c.plannedRiskFraction);
    if (heatWithCandidate > config.maxHeatFraction) {
      rejections.push({
        candidateId: c.candidateId,
        rejectCode: "portfolio_heat_breach",
        detail: `projected heat ${heatWithCandidate} > cap ${config.maxHeatFraction}`,
      });
      continue;
    }
    if (config.currentDailyLossFraction >= config.maxDailyLossFraction) {
      rejections.push({
        candidateId: c.candidateId,
        rejectCode: "portfolio_daily_loss_breach",
        detail: `daily loss ${config.currentDailyLossFraction} at stop ${config.maxDailyLossFraction}`,
      });
      continue;
    }
    let correlatedSkip = false;
    for (const s of selected) {
      const rho = corrBetween(c.instrument, s.instrument);
      if (rho > config.maxCorrelated) {
        rejections.push({
          candidateId: c.candidateId,
          rejectCode: "portfolio_correlated_skip",
          detail: `corr ${rho} with selected ${s.instrument} > max ${config.maxCorrelated}`,
        });
        correlatedSkip = true;
        break;
      }
    }
    if (correlatedSkip) continue;

    selected.push({
      candidateId: c.candidateId,
      strategyId: c.strategyId,
      instrument: c.instrument,
      direction: c.direction,
      expectedEdgeR: c.expectedEdgeR,
      correlationPenalty: bestPenalty,
      adjustedScoreR: bestScore,
    });
    projectedHeat = heatWithCandidate;
    pickedInstruments.set(c.instrument, perInst + 1);
    chosenInstrumentDirection.add(`${c.instrument}|${c.direction}`);
  }

  const content = [
    "pidec",
    decidedAtUtc,
    config.configVersion,
    regime.regimeState,
    selected.map((s) => `${s.candidateId}:${String(s.adjustedScoreR)}`).join(";"),
    rankTable.map((r) => `${r.candidateId}:${String(r.adjustedScoreR)}`).join(";"),
    rejections.map((r) => `${r.candidateId}:${r.rejectCode}`).join(";"),
    String(projectedHeat),
  ].join("|");
  return portfolioDecisionSchema.parse({
    decisionId: `pidec_${advHash16(content)}`,
    decidedAtUtc,
    configVersion: config.configVersion,
    regimeState: regime.regimeState,
    selected,
    rankTable,
    rejections,
    projectedHeatFraction: projectedHeat,
  });
}
