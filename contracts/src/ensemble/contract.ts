/**
 * Ensemble decision contract v1 (P06-01, ADR-0018).
 *
 * The ensemble COMBINES strategy evidence; it never replaces it. Every
 * decision preserves ALL input votes verbatim (individual strategy evidence
 * is never hidden — blueprint non-negotiable), carries the fixed auditable
 * weight-table version used, the regime context it consulted, the pairwise
 * correlation penalty applied, a decomposed confidence component set and a
 * final decision class (`enter_long` / `enter_short` / `wait`).
 *
 * Semantics frozen here:
 * - `eventTimeUtc` is the bar OPEN time of the last CLOSED bar all votes
 *   were computed from (CANDLE_TIMESTAMP_SEMANTICS); no look-ahead.
 * - `decisionId` is the deterministic identity
 *   `ens_{instrument}_{timeframe}_{eventTimeUtc}` — at most one ensemble
 *   decision per (instrument, timeframe, closed bar); idempotent
 *   re-evaluation of the same input yields the same id and hash.
 * - `confidence` is an ENSEMBLE CERTAINTY score in [0,1] — NEVER a win
 *   probability and never a profit guarantee (blueprint non-negotiable).
 *   Empirical hit-rate lives separately under
 *   `confidenceComponents.calibration` (P06-04) so model certainty and
 *   measured frequency are always distinguishable.
 * - `votes` are sorted ascending by strategyId (deterministic wire form) and
 *   every vote carries full lineage (strategy id + logic semver + config
 *   semver + optional canonical Signal with its own snapshotHash).
 * - `componentVersions` records the version of EVERY component that
 *   produced the decision (ensemble engine, weight table via
 *   `weightsVersion`, regime classifier, ...) — decisions are auditable.
 * - `decisionHash` is sha256 of `serializeEnsembleDecisionCanonical`
 *   (computed by the backend builder / Python mirror; validated as
 *   lowercase hex here).
 * - The ensemble never calls a broker, clock or random source; it is a pure
 *   data component (ADR-0003/0005; strategy -> signal -> risk -> execution
 *   is a hard boundary — the ensemble sits between signal and risk).
 */
import { z } from "zod";

import { featureVersionSchema } from "../feature/definition";
import { instrumentIdSchema } from "../marketdata/instrument";
import { timeframeSchema, utcInstantSchema } from "../marketdata/time";
import { regimeContextSchema } from "../regime/context";
import { regimeStateSchema, REGIME_STATES } from "../regime/contract";
import {
  SIGNAL_DIRECTIONS,
  signalReasonCodeSchema,
  signalSchema,
  strategyIdSchema,
} from "../strategy/contract";

/**
 * Final decision classes. `wait` is a first-class outcome — absence of a
 * trade is explained, never an error (mirrors the strategy evaluation rule).
 */
export const ENSEMBLE_ACTIONS = ["enter_long", "enter_short", "wait"] as const;
export type EnsembleAction = (typeof ENSEMBLE_ACTIONS)[number];
export const ensembleActionSchema = z.enum(ENSEMBLE_ACTIONS);

/** Vote stances: a directional vote or an explicit, explained abstain. */
export const ENSEMBLE_STANCES = ["long", "short", "abstain"] as const;
export type EnsembleStance = (typeof ENSEMBLE_STANCES)[number];
export const ensembleStanceSchema = z.enum(ENSEMBLE_STANCES);

/**
 * Machine-readable ensemble reason codes (frozen for the P6 phase; extension
 * requires bumping `ensembleContractVersion`). Sorted lexicographically and
 * deduplicated on the wire.
 */
export const ENSEMBLE_REASON_CODES = [
  "conflicting_votes", // both directions carry vote mass -> WAIT (P06-02)
  "correlation_penalty_applied", // pairwise-correlation penalty < 1 (P06-02)
  "cost_edge_below_minimum", // net edge does not clear costs (P06-03)
  "insufficient_vote_mass", // weighted score below threshold (P06-02)
  "no_directional_votes", // every strategy abstained (P06-02)
  "regime_context_degraded", // stale/missing HTF context -> fail closed (P06-02)
  "regime_gate_rejected", // regime state blocks entries (P06-02)
  "uncalibrated_confidence", // no empirical calibration data (P06-04)
  "vote_weighting_applied", // fixed weights applied (P06-02)
] as const;
export type EnsembleReasonCode = (typeof ENSEMBLE_REASON_CODES)[number];
export const ensembleReasonCodeSchema = z.enum(ENSEMBLE_REASON_CODES);

/**
 * Uncertainty flags (P06-04 layer): thin-evidence markers that UI/API must be
 * able to read separately from confidence. Sorted, unique on the wire.
 */
export const ENSEMBLE_UNCERTAINTY_FLAGS = [
  "conflicting_votes", // directional mass on both sides
  "high_correlation_penalty", // votes largely the same bet
  "low_calibration_sample", // empirical hit-rate from too few outcomes
  "no_calibration_data", // no outcomes recorded yet
  "stale_regime_context", // HTF context degraded
] as const;
export type EnsembleUncertaintyFlag = (typeof ENSEMBLE_UNCERTAINTY_FLAGS)[number];
export const ensembleUncertaintyFlagSchema = z.enum(ENSEMBLE_UNCERTAINTY_FLAGS);


/**
 * ONE strategy's vote for one (instrument, timeframe, closed bar). Carries
 * full lineage and — when the strategy emitted a signal — the verbatim
 * canonical Signal (with its own snapshotHash); an abstain never carries a
 * signal. `confidence` is strategy certainty in [0,1], never a win
 * probability (reuses the P05-01 semantics).
 */
export const ensembleVoteSchema = z
  .object({
    strategyId: strategyIdSchema,
    /** Semver of the strategy LOGIC that produced this vote. */
    strategyVersion: featureVersionSchema,
    /** Semver of the strategy CONFIG used. */
    configVersion: featureVersionSchema,
    instrument: instrumentIdSchema,
    timeframe: timeframeSchema,
    /** Bar OPEN time (UTC) of the last closed bar the vote derives from. */
    eventTimeUtc: utcInstantSchema,
    /** Directional vote or explicit abstain. */
    stance: ensembleStanceSchema,
    /** Strategy certainty in [0,1] — never a win probability. */
    confidence: z.number().min(0).max(1),
    /** Sorted unique reason codes explaining the stance (signal enum reused). */
    reasonCodes: z.array(signalReasonCodeSchema).min(1),
    /** The emitted canonical signal, when this vote is directional (else null). */
    signal: signalSchema.nullable(),
  })
  .strict()
  .refine(
    (v) =>
      v.reasonCodes.every((code, i) => i === 0 || code > v.reasonCodes[i - 1]) &&
      new Set(v.reasonCodes).size === v.reasonCodes.length,
    { message: "reasonCodes must be sorted and unique", path: ["reasonCodes"] },
  )
  .refine((v) => v.signal === null || v.signal.strategyId === v.strategyId, {
    message: "signal strategyId must match the vote",
    path: ["signal"],
  })
  .refine((v) => v.signal === null || v.signal.direction === v.stance, {
    message: "signal direction must match the vote stance",
    path: ["signal"],
  })
  .refine(
    (v) =>
      v.signal === null ||
      (v.signal.instrument === v.instrument &&
        v.signal.timeframe === v.timeframe &&
        v.signal.eventTimeUtc === v.eventTimeUtc),
    { message: "signal must anchor to the vote's coordinates", path: ["signal"] },
  );

export type EnsembleVote = z.infer<typeof ensembleVoteSchema>;

/**
 * Fixed, auditable baseline weights per regime state (P06-02 uses these; the
 * contract pins the shape now). Every regime state MUST declare a weight
 * record (possibly empty = no strategy eligible in that regime — fail-closed
 * lookup, never a missing-key improvisation). Weights are non-negative
 * finite numbers; normalization is the engine's deterministic job.
 */
export const ensembleWeightTableSchema = z
  .object({
    /** Semver of the weight table (any weight change bumps it). */
    version: featureVersionSchema,
    /** regime state -> strategy id -> weight (>= 0). */
    weights: z.record(regimeStateSchema, z.record(strategyIdSchema, z.number().finite().min(0))),
  })
  .strict()
  .refine((t) => REGIME_STATES.every((state) => typeof t.weights[state] === "object"), {
    message: "weights must declare every regime state (empty record allowed)",
    path: ["weights"],
  });

export type EnsembleWeightTable = z.infer<typeof ensembleWeightTableSchema>;

/**
 * Pairwise vote-correlation penalty (explicit, auditable input — the
 * ensemble penalizes strategies that are effectively the same bet). Keys are
 * `strategyA|strategyB` with the two ids strictly ascending; values are
 * correlations in [-1, 1]. `penaltyFactor` in [0,1] is the multiplicative
 * penalty applied to the combined score (1 = none).
 */
export const ensembleCorrelationPenaltySchema = z
  .object({
    /** Pair key `a|b` (ids strictly ascending, kebab-case) -> correlation [-1,1]. */
    pairCorrelations: z.record(
      z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\|[a-z0-9]+(?:-[a-z0-9]+)*$/),
      z.number().min(-1).max(1),
    ),
    /** Multiplicative score penalty in [0,1] (1 = no penalty). */
    penaltyFactor: z.number().min(0).max(1),
    /** Auditable provenance of the estimate (e.g. lookback window id). */
    source: z.string().min(1),
  })
  .strict()
  .refine(
    (p) =>
      Object.entries(p.pairCorrelations).every(([key]) => key.split("|")[0] < key.split("|")[1]),
    { message: "pair keys must be strategyA|strategyB with ids ascending", path: ["pairCorrelations"] },
  );

export type EnsembleCorrelationPenalty = z.infer<typeof ensembleCorrelationPenaltySchema>;

/**
 * Calibration view (P06-04 fills this; the contract pins the separation now):
 * the EMPIRICAL hit-rate of the deciding configuration, kept strictly apart
 * from model confidence. `empiricalHitRate` is null when no outcomes are
 * recorded yet (uncertainty flag `no_calibration_data`). NEVER a guarantee.
 */
export const ensembleCalibrationViewSchema = z
  .object({
    /** Empirical fraction of decided outcomes that hit target, or null. */
    empiricalHitRate: z.number().min(0).max(1).nullable(),
    /** Number of decided outcomes the hit-rate was computed from (>= 0). */
    sampleSize: z.number().int().min(0),
    /** Sorted unique thin-evidence flags. */
    uncertaintyFlags: z.array(ensembleUncertaintyFlagSchema),
  })
  .strict()
  .refine(
    (c) =>
      c.uncertaintyFlags.every((f, i) => i === 0 || f > c.uncertaintyFlags[i - 1]) &&
      new Set(c.uncertaintyFlags).size === c.uncertaintyFlags.length,
    { message: "uncertaintyFlags must be sorted and unique", path: ["uncertaintyFlags"] },
  )
  .refine((c) => c.empiricalHitRate !== null || c.sampleSize === 0, {
    message: "a null hit-rate requires sampleSize 0 (no outcomes recorded)",
    path: ["sampleSize"],
  });

export type EnsembleCalibrationView = z.infer<typeof ensembleCalibrationViewSchema>;

/**
 * Decomposed confidence components — every number the ensemble confidence
 * was derived from, so a decision is explainable without re-running it.
 */
export const ensembleConfidenceComponentsSchema = z
  .object({
    /** Fraction of non-abstaining votes agreeing with the decision stance. */
    voteAgreement: z.number().min(0).max(1),
    /** Weighted fraction of agreeing vote mass. */
    weightedAgreement: z.number().min(0).max(1),
    /** Regime-state alignment of the decision in [0,1]. */
    regimeAlignment: z.number().min(0).max(1),
    /** Correlation penalty factor in [0,1] (1 = no penalty). */
    correlationPenalty: z.number().min(0).max(1),
    /** Empirical calibration view (kept separate from model confidence). */
    calibration: ensembleCalibrationViewSchema,
  })
  .strict();

export type EnsembleConfidenceComponents = z.infer<typeof ensembleConfidenceComponentsSchema>;

/**
 * Per-strategy weighted contribution — the explainable score decomposition.
 * `weightedContribution` is the signed weighted score mass of this vote
 * (direction * weight * confidence; abstain contributes 0).
 */
export const ensembleContributionSchema = z
  .object({
    strategyId: strategyIdSchema,
    stance: ensembleStanceSchema,
    /** Fixed weight applied (from the weight table, regime-resolved). */
    weight: z.number().finite().min(0),
    /** Vote confidence in [0,1]. */
    confidence: z.number().min(0).max(1),
    /** Signed weighted score mass of this vote. */
    weightedContribution: z.number().finite(),
  })
  .strict()
  .refine((c) => c.stance !== "abstain" || c.weightedContribution === 0, {
    message: "abstain contributes 0 (directional votes may contribute 0 when their resolved weight is 0)",
    path: ["weightedContribution"],
  });

export type EnsembleContribution = z.infer<typeof ensembleContributionSchema>;



/** Deterministic ensemble decision identity (one per instrument/bar). */
export function ensembleDecisionIdFor(decision: {
  instrument: string;
  timeframe: string;
  eventTimeUtc: string;
}): string {
  return ["ens", decision.instrument, decision.timeframe, decision.eventTimeUtc].join("_");
}

/**
 * The ensemble INPUT: everything one evaluation consumes. Closed-world and
 * strict — the engine (P06-02) consumes exactly this, nothing else.
 */
export const ensembleInputSchema = z
  .object({
    instrument: instrumentIdSchema,
    timeframe: timeframeSchema,
    /** Bar OPEN time (UTC) of the last closed bar all votes derive from. */
    eventTimeUtc: utcInstantSchema,
    /** Strategy votes, sorted ascending by strategyId (min 1 — an empty
     *  ensemble is not an evaluation; a no-vote bar has no decision). */
    votes: z.array(ensembleVoteSchema).min(1),
    /** Higher-timeframe regime context for the same event time (P04-03). */
    regimeContext: regimeContextSchema,
    /** The fixed weight table this evaluation applies. */
    weightTable: ensembleWeightTableSchema,
    /** Pairwise correlation penalty applied to the combined score. */
    correlationPenalty: ensembleCorrelationPenaltySchema,
    /** Version of every component involved (engine, classifier, ...). */
    componentVersions: z.record(z.string().min(1), featureVersionSchema),
  })
  .strict()
  .refine(
    (i) =>
      i.votes.every(
        (v) =>
          v.instrument === i.instrument &&
          v.timeframe === i.timeframe &&
          v.eventTimeUtc === i.eventTimeUtc,
      ),
    { message: "votes must match the input coordinates", path: ["votes"] },
  )
  .refine(
    (i) => i.votes.every((v, idx) => idx === 0 || v.strategyId > i.votes[idx - 1].strategyId),
    { message: "votes must be sorted ascending by strategyId (unique)", path: ["votes"] },
  );

export type EnsembleInput = z.infer<typeof ensembleInputSchema>;


/**
 * The final ensemble decision — the ONLY object the ensemble emits
 * downstream. Every vote is preserved verbatim; the score decomposition,
 * weight-table version, regime context, correlation penalty and all
 * component versions are recorded for full auditability.
 */
export const ensembleDecisionSchema = z
  .object({
    decisionId: z.string().min(4),
    instrument: instrumentIdSchema,
    timeframe: timeframeSchema,
    /** Bar OPEN time (UTC) of the last closed bar all votes derive from. */
    eventTimeUtc: utcInstantSchema,
    /** Final decision class (`wait` is a first-class explained outcome). */
    action: ensembleActionSchema,
    /** Direction implied by the action (null only for `wait`). */
    direction: z.enum(SIGNAL_DIRECTIONS).nullable(),
    /** Semver of the ensemble engine logic that produced this decision. */
    ensembleVersion: featureVersionSchema,
    /** Semver of the weight table applied (auditable weights). */
    weightsVersion: featureVersionSchema,
    /** Strategy the decision is primarily grounded in (null for `wait`). */
    dominantStrategyId: strategyIdSchema.nullable(),
    /** Ensemble certainty in [0,1] — NEVER a win probability. */
    confidence: z.number().min(0).max(1),
    /** Decomposed confidence components (explainable). */
    confidenceComponents: ensembleConfidenceComponentsSchema,
    /** Explainable score decomposition, sorted ascending by strategyId. */
    contributions: z.array(ensembleContributionSchema).min(1),
    /** ALL input votes preserved verbatim (evidence is never hidden). */
    votes: z.array(ensembleVoteSchema).min(1),
    /** Regime context consulted (verbatim). */
    regimeContext: regimeContextSchema,
    /** Correlation penalty applied. */
    correlationPenalty: ensembleCorrelationPenaltySchema,
    /** Sorted unique ensemble reason codes explaining the decision. */
    reasonCodes: z.array(ensembleReasonCodeSchema).min(1),
    /** Version of every component involved in producing this decision. */
    componentVersions: z.record(z.string().min(1), featureVersionSchema),
    /** sha256 of the canonical serialization (hex, lowercase). */
    decisionHash: z.string().regex(/^[0-9a-f]{64}$/),
    ensembleContractVersion: z.literal(1),
  })
  .strict()
  .refine((d) => d.decisionId === ensembleDecisionIdFor(d), {
    message: "decisionId must be the deterministic id of its own fields",
    path: ["decisionId"],
  })
  .refine(
    (d) =>
      d.reasonCodes.every((code, i) => i === 0 || code > d.reasonCodes[i - 1]) &&
      new Set(d.reasonCodes).size === d.reasonCodes.length,
    { message: "reasonCodes must be sorted and unique", path: ["reasonCodes"] },
  )
  .refine(
    (d) => d.votes.every((v, idx) => idx === 0 || v.strategyId > d.votes[idx - 1].strategyId),
    { message: "votes must be sorted ascending by strategyId (unique)", path: ["votes"] },
  )
  .refine(
    (d) =>
      d.votes.every(
        (v) =>
          v.instrument === d.instrument &&
          v.timeframe === d.timeframe &&
          v.eventTimeUtc === d.eventTimeUtc,
      ),
    { message: "votes must match the decision coordinates", path: ["votes"] },
  )
  .refine(
    (d) =>
      d.contributions.every((c, i) => i === 0 || c.strategyId > d.contributions[i - 1].strategyId),
    { message: "contributions must be sorted ascending by strategyId", path: ["contributions"] },
  )
  .refine(
    (d) =>
      d.contributions.length === d.votes.length &&
      d.contributions.every(
        (c, i) =>
          c.strategyId === d.votes[i].strategyId &&
          c.stance === d.votes[i].stance &&
          c.confidence === d.votes[i].confidence,
      ),
    {
      message: "contributions must mirror the votes (same strategies, stances, confidences)",
      path: ["contributions"],
    },
  )
  .refine(
    (d) =>
      (d.action === "enter_long" && d.direction === "long") ||
      (d.action === "enter_short" && d.direction === "short") ||
      (d.action === "wait" && d.direction === null),
    { message: "action and direction must be consistent (wait => null direction)", path: ["action"] },
  )
  .refine(
    (d) =>
      d.action === "wait" ||
      (d.dominantStrategyId !== null &&
        d.votes.some((v) => v.strategyId === d.dominantStrategyId && v.stance === d.direction)),
    {
      message: "enter actions require a dominant strategy that voted in the decision direction",
      path: ["dominantStrategyId"],
    },
  )
  .refine((d) => Object.keys(d.componentVersions).length >= 1, {
    message: "componentVersions must record at least the ensemble engine version",
    path: ["componentVersions"],
  });

export type EnsembleDecision = z.infer<typeof ensembleDecisionSchema>;

/**
 * Serialization input: every content field the hash covers — `decisionHash`
 * is excluded (hash input never contains the hash). Byte-identical across
 * runs and with the Python mirror (which reimplements `String(number)` as
 * `js_number_str`, P02-05). Changing this form is a breaking change (pinned
 * by contract tests + the committed parity fixture).
 */
export type EnsembleDecisionContent = Omit<EnsembleDecision, "decisionHash">;

/** Canonical ensemble decision serialization for hashing (stable order). */
export function serializeEnsembleDecisionCanonical(decision: EnsembleDecisionContent): string {
  const num = (v: number): string => String(v);
  const numOrNull = (v: number | null): string => (v === null ? "-" : String(v));
  const cc = decision.confidenceComponents;
  const flags = cc.calibration.uncertaintyFlags.join(";");
  const pairs = Object.keys(decision.correlationPenalty.pairCorrelations)
    .sort()
    .map((k) => `${k}:${num(decision.correlationPenalty.pairCorrelations[k])}`)
    .join(";");
  const votes = decision.votes
    .map((v) =>
      [
        v.strategyId,
        v.strategyVersion,
        v.configVersion,
        v.stance,
        num(v.confidence),
        v.signal === null ? "-" : v.signal.snapshotHash,
      ].join("~")
    )
    .join(";");
  const contributions = decision.contributions
    .map((c) =>
      [c.strategyId, c.stance, num(c.weight), num(c.confidence), num(c.weightedContribution)].join(
        "~",
      )
    )
    .join(";");
  const compVersions = Object.keys(decision.componentVersions)
    .sort()
    .map((k) => `${k}=${decision.componentVersions[k]}`)
    .join(";");
  return [
    "ensemble",
    decision.decisionId,
    decision.instrument,
    decision.timeframe,
    decision.eventTimeUtc,
    decision.action,
    decision.direction ?? "-",
    decision.ensembleVersion,
    decision.weightsVersion,
    decision.dominantStrategyId ?? "-",
    num(decision.confidence),
    num(cc.voteAgreement),
    num(cc.weightedAgreement),
    num(cc.regimeAlignment),
    num(cc.correlationPenalty),
    numOrNull(cc.calibration.empiricalHitRate),
    num(cc.calibration.sampleSize),
    flags,
    num(decision.correlationPenalty.penaltyFactor),
    pairs,
    decision.correlationPenalty.source,
    votes,
    contributions,
    decision.reasonCodes.join(";"),
    compVersions,
    String(decision.ensembleContractVersion),
  ].join("|");
}

