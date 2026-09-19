/**
 * Meta-labeling research pipeline (P18-01, ADR-0032 section 1).
 *
 * A SECONDARY model estimates whether a PRIMARY strategy signal is worth
 * taking. Frozen semantics:
 * - PRIMARY-SIGNAL CONTEXT: each sample pairs one primary signal with the
 *   feature snapshot AVAILABLE AT SIGNAL TIME. A context anchored at a
 *   LATER bar is post-signal leakage and fails closed at the boundary.
 * - LEAKAGE-SAFE LABELS: the binary label is whether the primary signal's
 *   outcome over a FORWARD horizon was favorable after costs
 *   (`netOutcomeR >= costThresholdR`). Purge provenance is carried as P09
 *   digests on the OOS evaluation request.
 * - OOS EVALUATION: the meta-labeler is evaluated only on out-of-sample
 *   samples (the P09 split test section); the report carries splitPlanHash
 *   + purgeReportHash provenance.
 * - ABSTAIN/ACCEPT: `decideMetaLabel` maps a meta probability to
 *   `accept`/`abstain` with an explicit reason code. Abstaining NEVER
 *   rewrites base-strategy history: decisions are append-only objects that
 *   reference the primary signal without mutating it.
 * - `probability` is a calibrated meta score in [0,1] — NEVER a guaranteed
 *   win probability (blueprint non-negotiable).
 * - Deterministic; UTC only; no clock/randomness/broker; ML stays OFF in
 *   production until the champion gate passes (ADR-0005/0026).
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";
import { advHash16, advRound6 } from "./util";

export const METALABEL_ID = "meta-labeling-pipeline";
export const METALABEL_VERSION = "1.0.0";

export class MetaLabelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaLabelError";
  }
}

/** Label source: net forward-bar outcome after costs. */
export const METALABEL_LABEL_SOURCES = ["forward_return"] as const;
export type MetaLabelSource = (typeof METALABEL_LABEL_SOURCES)[number];
export const metaLabelSourceSchema = z.enum(METALABEL_LABEL_SOURCES);

/** One primary signal's realized outcome over the label horizon. */
export const metaLabelOutcomeSchema = z
  .object({
    signalId: z.string().min(4),
    strategyId: z.string().min(2),
    instrument: z.string().min(2),
    timeframe: z.string().min(2),
    eventTimeUtc: utcInstantSchema,
    direction: z.enum(["long", "short"]),
    signalBarIndex: z.number().int().min(0),
    netOutcomeR: z.number().finite(),
    labelHorizonBars: z.number().int().min(1),
    strategyVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    configVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    labelKnownAtUtc: utcInstantSchema,
  })
  .strict();

export type MetaLabelOutcome = z.infer<typeof metaLabelOutcomeSchema>;

/** Binary-label request: label = (netOutcomeR >= costThresholdR). */
export const metaLabelRequestSchema = z
  .object({
    labelSource: metaLabelSourceSchema,
    costThresholdR: z.number().finite().min(0),
  })
  .strict();
export type MetaLabelRequest = z.infer<typeof metaLabelRequestSchema>;

/** One labeled sample: primary outcome + binary meta label. */
export const metaLabeledSampleSchema = z
  .object({
    outcome: metaLabelOutcomeSchema,
    label: z.number().int().min(0).max(1),
    costThresholdR: z.number().finite().min(0),
  })
  .strict()
  .refine(
    (s) => (s.outcome.netOutcomeR >= s.costThresholdR ? s.label === 1 : s.label === 0),
    { message: "label must equal (netOutcomeR >= costThresholdR)", path: ["label"] },
  );

export type MetaLabeledSample = z.infer<typeof metaLabeledSampleSchema>;

/** Label one primary outcome (deterministic threshold rule). */
export function labelMetaSample(
  outcome: MetaLabelOutcome,
  request: MetaLabelRequest,
): MetaLabeledSample {
  const o = metaLabelOutcomeSchema.parse(outcome);
  const req = metaLabelRequestSchema.parse(request);
  const label = o.netOutcomeR >= req.costThresholdR ? 1 : 0;
  return metaLabeledSampleSchema.parse({
    outcome: o,
    label,
    costThresholdR: req.costThresholdR,
  });
}

/** Label a chronological series of primary outcomes (idempotent, pure). */
export function labelMetaSamples(
  outcomes: readonly MetaLabelOutcome[],
  request: MetaLabelRequest,
): MetaLabeledSample[] {
  return outcomes.map((o) => labelMetaSample(o, request));
}

// ---------------------------------------------------------------------------
// Leakage-safe sample intake
// ---------------------------------------------------------------------------

/** At-signal-time feature context (P03 snapshot values + lineage). */
export const metaSampleContextSchema = z
  .object({
    signalId: z.string().min(4),
    /** Snapshot anchor MUST equal the signal's eventTimeUtc. */
    contextEventTimeUtc: utcInstantSchema,
    values: z.record(z.string().min(1), z.union([z.number(), z.boolean(), z.null()])),
    featureGroupId: z.string().min(1),
    featureGroupVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    datasetId: z.string().min(1),
    datasetDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type MetaSampleContext = z.infer<typeof metaSampleContextSchema>;

/**
 * A leakage-checked training sample: labeled sample + AT-SIGNAL-TIME
 * feature context. `contextEventTimeUtc` must equal the outcome's
 * `eventTimeUtc` — a later context is post-signal leakage (fail closed).
 */
export const metaTrainingSampleSchema = z
  .object({
    sample: metaLabeledSampleSchema,
    context: metaSampleContextSchema,
  })
  .strict()
  .superRefine((t, ctx) => {
    if (t.sample.outcome.signalId !== t.context.signalId) {
      ctx.addIssue({
        code: "custom",
        path: ["context", "signalId"],
        message: "context signalId must match the outcome signalId",
      });
    }
    if (t.context.contextEventTimeUtc !== t.sample.outcome.eventTimeUtc) {
      ctx.addIssue({
        code: "custom",
        path: ["context", "contextEventTimeUtc"],
        message:
          "context must be anchored at the signal event time (post-signal context is leakage)",
      });
    }
  });

export type MetaTrainingSample = z.infer<typeof metaTrainingSampleSchema>;

/**
 * Intake for one labeled sample + its feature context (leakage gate).
 * Throws `MetaLabelError` on leakage-shaped input (fail closed, never
 * silently repaired).
 */
export function buildMetaTrainingSample(
  sample: MetaLabeledSample,
  context: MetaSampleContext,
): MetaTrainingSample {
  const parsedSample = metaLabeledSampleSchema.parse(sample);
  const parsedContext = metaSampleContextSchema.parse(context);
  const joined = metaTrainingSampleSchema.safeParse({
    sample: parsedSample,
    context: parsedContext,
  });
  if (!joined.success) {
    throw new MetaLabelError(
      `leakage check failed: ${joined.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return joined.data;
}


// ---------------------------------------------------------------------------
// OOS evaluation
// ---------------------------------------------------------------------------

/** One meta-model score (caller-supplied; never a guaranteed win prob). */
export const metaScoreSchema = z
  .object({
    signalId: z.string().min(4),
    probability: z.number().finite().min(0).max(1),
    modelArtifactId: z.string().min(3),
  })
  .strict();
export type MetaScore = z.infer<typeof metaScoreSchema>;

/**
 * OOS evaluation request: labeled samples restricted to the OOS (test)
 * section of a P09 split plan, paired 1:1 with model scores. Provenance
 * hashes are P09 canonical-serialization digests.
 */
export const metaOosEvaluationRequestSchema = z
  .object({
    samples: z.array(metaLabeledSampleSchema).min(1),
    scores: z.array(metaScoreSchema).min(1),
    modelArtifactId: z.string().min(3),
    labelSource: metaLabelSourceSchema,
    costThresholdR: z.number().finite().min(0),
    splitPlanHash: z.string().regex(/^[0-9a-f]{16}$/),
    purgeReportHash: z.string().regex(/^[0-9a-f]{16}$/),
  })
  .strict()
  .refine(
    (r) => {
      const ids = new Set(r.samples.map((s) => s.outcome.signalId));
      const scoreIds = new Set(r.scores.map((s) => s.signalId));
      return (
        ids.size === r.samples.length &&
        scoreIds.size === r.scores.length &&
        ids.size === scoreIds.size
      );
    },
    { message: "samples and scores must pair 1:1 on unique signalIds", path: ["scores"] },
  )
  .refine((r) => r.scores.every((s) => s.modelArtifactId === r.modelArtifactId), {
    message: "every score must carry the evaluated modelArtifactId",
    path: ["scores"],
  });

export type MetaOosEvaluationRequest = z.infer<typeof metaOosEvaluationRequestSchema>;

/** Threshold-rule evaluation summary (deterministic confusion counts). */
export const metaEvaluationSummarySchema = z
  .object({
    modelArtifactId: z.string().min(3),
    labelSource: metaLabelSourceSchema,
    costThresholdR: z.number().finite().min(0),
    sampleSize: z.number().int().min(0),
    truePositives: z.number().int().min(0),
    falsePositives: z.number().int().min(0),
    trueNegatives: z.number().int().min(0),
    falseNegatives: z.number().int().min(0),
    precisionAccept: z.number().finite().min(0).max(1).nullable(),
    recallAccept: z.number().finite().min(0).max(1).nullable(),
    accuracy: z.number().finite().min(0).max(1).nullable(),
    splitPlanHash: z.string().regex(/^[0-9a-f]{16}$/),
    purgeReportHash: z.string().regex(/^[0-9a-f]{16}$/),
  })
  .strict();

export type MetaEvaluationSummary = z.infer<typeof metaEvaluationSummarySchema>;

/**
 * Build the OOS confusion summary at a fixed decision threshold. Pure
 * function of (samples, scores, threshold); deterministic.
 */
export function summarizeMetaOos(
  request: MetaOosEvaluationRequest,
  threshold: number,
): MetaEvaluationSummary {
  const r = metaOosEvaluationRequestSchema.parse(request);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new MetaLabelError(`threshold must be in [0,1]: ${threshold}`);
  }
  const scoreBySignal = new Map(r.scores.map((s) => [s.signalId, s.probability]));
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const s of r.samples) {
    const p = scoreBySignal.get(s.outcome.signalId);
    if (p === undefined) {
      throw new MetaLabelError(`missing score for signal ${s.outcome.signalId}`);
    }
    const predictedAccept = p >= threshold;
    const actualAccept = s.label === 1;
    if (predictedAccept && actualAccept) tp += 1;
    else if (predictedAccept && !actualAccept) fp += 1;
    else if (!predictedAccept && actualAccept) fn += 1;
    else tn += 1;
  }
  const n = r.samples.length;
  const precision = tp + fp === 0 ? null : advRound6(tp / (tp + fp));
  const recall = tp + fn === 0 ? null : advRound6(tp / (tp + fn));
  const accuracy = n === 0 ? null : advRound6((tp + tn) / n);
  return metaEvaluationSummarySchema.parse({
    modelArtifactId: r.modelArtifactId,
    labelSource: r.labelSource,
    costThresholdR: r.costThresholdR,
    sampleSize: n,
    truePositives: tp,
    falsePositives: fp,
    trueNegatives: tn,
    falseNegatives: fn,
    precisionAccept: precision,
    recallAccept: recall,
    accuracy,
    splitPlanHash: r.splitPlanHash,
    purgeReportHash: r.purgeReportHash,
  });
}

/** Canonical serialization of an OOS summary (hash input). */
export function serializeMetaEvaluationSummaryCanonical(s: MetaEvaluationSummary): string {
  const p = metaEvaluationSummarySchema.parse(s);
  return [
    "mlabsum",
    p.modelArtifactId,
    p.labelSource,
    String(p.costThresholdR),
    String(p.sampleSize),
    String(p.truePositives),
    String(p.falsePositives),
    String(p.trueNegatives),
    String(p.falseNegatives),
    p.precisionAccept === null ? "-" : String(p.precisionAccept),
    p.recallAccept === null ? "-" : String(p.recallAccept),
    p.accuracy === null ? "-" : String(p.accuracy),
    p.splitPlanHash,
    p.purgeReportHash,
  ].join("|");
}

/** Deterministic content-addressed OOS summary hash. */
export function metaEvaluationSummaryHashFor(s: MetaEvaluationSummary): string {
  return advHash16(serializeMetaEvaluationSummaryCanonical(s));
}

// ---------------------------------------------------------------------------
// Abstain/accept decisions (base history untouched)
// ---------------------------------------------------------------------------

export const METALABEL_ACTIONS = ["accept", "abstain"] as const;
export type MetaLabelAction = (typeof METALABEL_ACTIONS)[number];
export const metaLabelActionSchema = z.enum(METALABEL_ACTIONS);

/** Machine-readable meta-label decision reason codes (frozen). */
export const METALABEL_REASON_CODES = [
  "meta_label_above_threshold",
  "meta_label_below_threshold",
  "meta_label_insufficient_samples",
  "meta_label_model_not_registered",
] as const;
export type MetaLabelReasonCode = (typeof METALABEL_REASON_CODES)[number];
export const metaLabelReasonCodeSchema = z.enum(METALABEL_REASON_CODES);

/**
 * One abstain/accept decision over a primary signal. APPEND-ONLY intent:
 * the decision references the signal but never mutates it — base-strategy
 * history stays intact (acceptance criterion).
 */
export const metaLabelDecisionSchema = z
  .object({
    decisionId: z.string().regex(/^mlab_[0-9a-f]{16}$/),
    action: metaLabelActionSchema,
    reasonCode: metaLabelReasonCodeSchema,
    signalId: z.string().min(4),
    probability: z.number().finite().min(0).max(1).nullable(),
    threshold: z.number().finite().min(0).max(1),
    modelArtifactId: z.string().min(3),
    decidedAtUtc: utcInstantSchema,
    oosSummaryHash: z.string().regex(/^[0-9a-f]{16}$/).nullable(),
  })
  .strict();

export type MetaLabelDecision = z.infer<typeof metaLabelDecisionSchema>;

/** Content fields the decision hash covers (hash excluded). */
export type MetaLabelDecisionContent = Omit<MetaLabelDecision, "decisionId">;

/** Canonical serialization (hash input; pipe-joined). */
export function serializeMetaLabelDecisionCanonical(d: MetaLabelDecisionContent): string {
  return [
    "mlab",
    d.action,
    d.reasonCode,
    d.signalId,
    d.probability === null ? "-" : String(d.probability),
    String(d.threshold),
    d.modelArtifactId,
    d.decidedAtUtc,
    d.oosSummaryHash ?? "-",
  ].join("|");
}

/** Deterministic content-addressed decision id. */
export function metaLabelDecisionIdFor(d: MetaLabelDecisionContent): string {
  return `mlab_${advHash16(serializeMetaLabelDecisionCanonical(d))}`;
}

/**
 * Decide accept/abstain for one primary signal.
 *
 * Policy (frozen): accept iff the model is registered AND the OOS evidence
 * meets minOosSamples AND the model score >= threshold. Every abstain
 * carries an explicit reason code. NEVER touches the primary signal record.
 */
export function decideMetaLabel(input: {
  score: MetaScore;
  threshold: number;
  decidedAtUtc: string;
  modelRegistered: boolean;
  minOosSamples: number;
  oosSummary: MetaEvaluationSummary | null;
}): MetaLabelDecision {
  const score = metaScoreSchema.parse(input.score);
  if (!Number.isFinite(input.threshold) || input.threshold < 0 || input.threshold > 1) {
    throw new MetaLabelError(`threshold must be in [0,1]: ${input.threshold}`);
  }
  const decidedAtUtc = utcInstantSchema.parse(input.decidedAtUtc);
  if (!Number.isInteger(input.minOosSamples) || input.minOosSamples < 0) {
    throw new MetaLabelError(`minOosSamples must be an integer >= 0: ${input.minOosSamples}`);
  }
  let action: MetaLabelAction;
  let reasonCode: MetaLabelReasonCode;
  let oosSummaryHash: string | null = null;
  if (!input.modelRegistered) {
    action = "abstain";
    reasonCode = "meta_label_model_not_registered";
  } else if (input.oosSummary === null || input.oosSummary.sampleSize < input.minOosSamples) {
    action = "abstain";
    reasonCode = "meta_label_insufficient_samples";
    if (input.oosSummary !== null) {
      oosSummaryHash = metaEvaluationSummaryHashFor(input.oosSummary);
    }
  } else {
    oosSummaryHash = metaEvaluationSummaryHashFor(input.oosSummary);
    if (score.probability >= input.threshold) {
      action = "accept";
      reasonCode = "meta_label_above_threshold";
    } else {
      action = "abstain";
      reasonCode = "meta_label_below_threshold";
    }
  }
  const content: MetaLabelDecisionContent = {
    action,
    reasonCode,
    signalId: score.signalId,
    probability: score.probability,
    threshold: input.threshold,
    modelArtifactId: score.modelArtifactId,
    decidedAtUtc,
    oosSummaryHash,
  };
  return metaLabelDecisionSchema.parse({
    ...content,
    decisionId: metaLabelDecisionIdFor(content),
  });
}

/**
 * Full deterministic pipeline: label outcomes with the threshold rule,
 * validate at-signal-time contexts (leakage gate), evaluate scores on the
 * OOS samples. Returns labeled samples, validated training pairs and the
 * OOS summary with its content-addressed hash.
 */
export function runMetaLabelingPipeline(input: {
  labelSource: MetaLabelSource;
  costThresholdR: number;
  outcomes: readonly MetaLabelOutcome[];
  contexts: readonly MetaSampleContext[];
  oosSamples: readonly MetaLabeledSample[];
  scores: readonly MetaScore[];
  modelArtifactId: string;
  threshold: number;
  splitPlanHash: string;
  purgeReportHash: string;
}): {
  labeled: MetaLabeledSample[];
  trainingSamples: MetaTrainingSample[];
  oosSummary: MetaEvaluationSummary;
  oosSummaryHash: string;
} {
  const request = metaLabelRequestSchema.parse({
    labelSource: input.labelSource,
    costThresholdR: input.costThresholdR,
  });
  const labeled = labelMetaSamples(input.outcomes, request);
  const contexts = input.contexts.map((c) => metaSampleContextSchema.parse(c));
  const contextBySignal = new Map(contexts.map((c) => [c.signalId, c]));
  const trainingSamples: MetaTrainingSample[] = [];
  for (const s of labeled) {
    const ctx = contextBySignal.get(s.outcome.signalId);
    if (ctx === undefined) {
      throw new MetaLabelError(`missing at-signal-time context for ${s.outcome.signalId}`);
    }
    trainingSamples.push(buildMetaTrainingSample(s, ctx));
  }
  const oosSummary = summarizeMetaOos(
    {
      samples: input.oosSamples.map((s) => metaLabeledSampleSchema.parse(s)),
      scores: input.scores.map((s) => metaScoreSchema.parse(s)),
      modelArtifactId: input.modelArtifactId,
      labelSource: input.labelSource,
      costThresholdR: input.costThresholdR,
      splitPlanHash: input.splitPlanHash,
      purgeReportHash: input.purgeReportHash,
    },
    input.threshold,
  );
  return {
    labeled,
    trainingSamples,
    oosSummary,
    oosSummaryHash: metaEvaluationSummaryHashFor(oosSummary),
  };
}
