/**
 * ML challenger framework (P18-02, ADR-0032 section 2).
 *
 * Frozen semantics:
 * - MODEL REGISTRY: model versions register through the P13 registry
 *   (`RegistryEntry`, kind `model`); the advanced-alpha layer REUSES that
 *   contract rather than inventing a second one. A model entry carries
 *   `RegistryModelMetadata` (feature set lineage, train dataset id +
 *   digest, hyperparameters).
 * - FEATURE SCHEMA BINDING: a challenger binds to a frozen feature-set
 *   schema (featureId@version list). A score whose input features deviate
 *   from the bound schema is rejected (no silent feature drift).
 * - TRAINING MANIFEST: every challenger carries a training manifest —
 *   dataset id + digest, split plan hash, purge report hash, label rule
 *   (P18-01 label source + cost threshold), feature schema, hyperparams.
 * - TIME-AWARE VALIDATION: the evaluation evidence must reference P09
 *   walk-forward + purge/embargo digests (forward-only folds).
 * - CALIBRATION CHECK: Brier score + calibration gap over OOS samples;
 *   a challenger beyond the thresholds FAILS the gate.
 * - DRIFT CHECK: feature mean-shift z-scores train -> OOS; any feature
 *   beyond the threshold flags the evidence as drifted (cannot pass).
 * - CHAMPION/CHALLENGER COMPARISON: deterministic comparator over the
 *   frozen metric set; a challenger promotes only when it beats the
 *   champion on the primary metric and is at least as good on guardrails.
 * - PRODUCTION GATE: `assessMlGate` refuses ANY production enablement
 *   unless every evidence field is present and every check passes — ML
 *   stays OFF by default (ADR-0005; blueprint champion gate).
 * - Deterministic; UTC; no clock/random/broker access.
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";
import { advHash16, advRound6 } from "./util";

export const ML_CHALLENGER_ID = "ml-challenger-framework";
export const ML_CHALLENGER_VERSION = "1.0.0";

export class MlChallengerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MlChallengerError";
  }
}

/** Feature-schema binding: one frozen feature slot (id + semver). */
export const featureBindingSchema = z
  .object({
    featureId: z.string().regex(/^[a-z0-9._-]+$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
  })
  .strict();
export type FeatureBinding = z.infer<typeof featureBindingSchema>;

/** A complete feature-set schema: >= 1 binding, unique featureIds. */
export const featureSetSchemaSchema = z
  .array(featureBindingSchema)
  .min(1)
  .refine((s) => new Set(s.map((b) => b.featureId)).size === s.length, {
    message: "featureIds must be unique within the feature-set schema",
  });
export type FeatureSetSchema = z.infer<typeof featureSetSchemaSchema>;

/** Canonical feature-set serialization (sorted by featureId). */
export function serializeFeatureSetSchema(schema: FeatureSetSchema): string {
  const sorted = [...schema].sort((a, b) => a.featureId.localeCompare(b.featureId));
  return sorted.map((b) => `${b.featureId}@${b.version}`).join(",");
}

/** Deterministic content-addressed feature-set hash (schema-validated). */
export function featureSetHashFor(schema: FeatureSetSchema): string {
  const parsed = featureSetSchemaSchema.parse(schema);
  return advHash16(`fset|${serializeFeatureSetSchema(parsed)}`);
}

/**
 * Validate that scored input features exactly match the bound schema (set
 * equality, not subset). Any deviation rejects: no silent feature drift at
 * the scoring boundary.
 */
export function featuresMatchSchema(
  values: Readonly<Record<string, number | boolean | null>>,
  schema: FeatureSetSchema,
): boolean {
  const expected = new Set(schema.map((b) => b.featureId));
  const actual = new Set(Object.keys(values));
  if (expected.size !== actual.size) return false;
  for (const id of expected) if (!actual.has(id)) return false;
  return true;
}

/** Label-rule provenance carried verbatim from the P18-01 pipeline. */
export const labelRuleSchema = z
  .object({
    labelSource: z.enum(["forward_return"]),
    costThresholdR: z.number().finite().min(0),
  })
  .strict();
export type LabelRule = z.infer<typeof labelRuleSchema>;

/**
 * The training manifest: EVERYTHING needed to reproduce the training set.
 * Any missing field fails the schema (fail closed) — a challenger without
 * full provenance cannot exist.
 */
export const trainingManifestSchema = z
  .object({
    modelArtifactId: z.string().min(3),
    trainDatasetId: z.string().min(1),
    trainDatasetDigest: z.string().regex(/^[0-9a-f]{64}$/),
    splitPlanHash: z.string().regex(/^[0-9a-f]{16}$/),
    purgeReportHash: z.string().regex(/^[0-9a-f]{16}$/),
    featureSetHash: z.string().regex(/^[0-9a-f]{16}$/),
    labelRule: labelRuleSchema,
    hyperparams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    modelFamily: z.string().min(1).max(64),
    trainStartUtc: utcInstantSchema,
    trainEndUtc: utcInstantSchema,
  })
  .strict()
  .refine((m) => m.trainStartUtc < m.trainEndUtc, {
    message: "trainStartUtc must be before trainEndUtc",
    path: ["trainEndUtc"],
  });

export type TrainingManifest = z.infer<typeof trainingManifestSchema>;

/** Canonical training-manifest serialization (hash input). */
export function serializeTrainingManifestCanonical(m: TrainingManifest): string {
  const p = trainingManifestSchema.parse(m);
  const hp = Object.keys(p.hyperparams)
    .sort()
    .map((k) => `${k}=${String(p.hyperparams[k])}`)
    .join(",");
  return [
    "mlman",
    p.modelArtifactId,
    p.trainDatasetId,
    p.trainDatasetDigest,
    p.splitPlanHash,
    p.purgeReportHash,
    p.featureSetHash,
    p.labelRule.labelSource,
    String(p.labelRule.costThresholdR),
    p.modelFamily,
    hp,
    p.trainStartUtc,
    p.trainEndUtc,
  ].join("|");
}

/** Deterministic content-addressed manifest hash. */
export function trainingManifestHashFor(m: TrainingManifest): string {
  return advHash16(serializeTrainingManifestCanonical(m));
}

/**
 * Out-of-sample evaluation evidence for one model version. Every field is
 * REQUIRED — the gate refuses production when any is missing (the schema
 * itself fails closed on malformed input).
 */
export const oosEvidenceSchema = z
  .object({
    modelArtifactId: z.string().min(3),
    trainingManifestHash: z.string().regex(/^[0-9a-f]{16}$/),
    walkforwardPlanHash: z.string().regex(/^[0-9a-f]{16}$/),
    purgeReportHash: z.string().regex(/^[0-9a-f]{16}$/),
    oosSampleSize: z.number().int().min(1),
    oosAccuracy: z.number().finite().min(0).max(1),
    oosPrecisionAccept: z.number().finite().min(0).max(1).nullable(),
    oosBrierScore: z.number().finite().min(0).max(1),
    oosCalibrationGap: z.number().finite().min(0).max(1),
    maxFeatureDriftZ: z.number().finite().min(0),
    driftedFeatureCount: z.number().int().min(0),
    evaluatedAtUtc: utcInstantSchema,
  })
  .strict();

export type OosEvidence = z.infer<typeof oosEvidenceSchema>;

/** Canonical evidence serialization (hash input). */
export function serializeOosEvidenceCanonical(e: OosEvidence): string {
  const p = oosEvidenceSchema.parse(e);
  return [
    "mlevid",
    p.modelArtifactId,
    p.trainingManifestHash,
    p.walkforwardPlanHash,
    p.purgeReportHash,
    String(p.oosSampleSize),
    String(p.oosAccuracy),
    p.oosPrecisionAccept === null ? "-" : String(p.oosPrecisionAccept),
    String(p.oosBrierScore),
    String(p.oosCalibrationGap),
    String(p.maxFeatureDriftZ),
    String(p.driftedFeatureCount),
    p.evaluatedAtUtc,
  ].join("|");
}

/** Deterministic content-addressed evidence hash. */
export function oosEvidenceHashFor(e: OosEvidence): string {
  return advHash16(serializeOosEvidenceCanonical(e));
}

/** Per-feature drift statistic between training and OOS windows. */
export const featureDriftStatSchema = z
  .object({
    featureId: z.string().regex(/^[a-z0-9._-]+$/),
    trainMean: z.number().finite(),
    oosMean: z.number().finite(),
    pooledStd: z.number().finite().positive(),
    zScore: z.number().finite().min(0),
  })
  .strict()
  .refine((s) => s.zScore === advRound6(Math.abs(s.oosMean - s.trainMean) / s.pooledStd), {
    message: "zScore must equal |oosMean - trainMean| / pooledStd",
    path: ["zScore"],
  });
export type FeatureDriftStat = z.infer<typeof featureDriftStatSchema>;

/** Compute one drift statistic (deterministic; caller supplies moments). */
export function computeFeatureDrift(input: {
  featureId: string;
  trainMean: number;
  oosMean: number;
  pooledStd: number;
}): FeatureDriftStat {
  if (!Number.isFinite(input.pooledStd) || input.pooledStd <= 0) {
    throw new MlChallengerError(
      `pooledStd must be finite and > 0 for ${input.featureId}: ${input.pooledStd}`,
    );
  }
  const z = advRound6(Math.abs(input.oosMean - input.trainMean) / input.pooledStd);
  return featureDriftStatSchema.parse({ ...input, zScore: z });
}

/**
 * Drift verdict over all features: any feature beyond `thresholdZ` counts
 * as drifted; evidence with drifted features cannot pass the ML gate.
 */
export function driftVerdict(
  stats: readonly FeatureDriftStat[],
  thresholdZ: number,
): { driftedFeatures: FeatureDriftStat[]; maxZ: number } {
  if (!Number.isFinite(thresholdZ) || thresholdZ <= 0) {
    throw new MlChallengerError(`thresholdZ must be finite and > 0: ${thresholdZ}`);
  }
  const sorted = [...stats].sort((a, b) => a.featureId.localeCompare(b.featureId));
  const drifted = sorted.filter((s) => s.zScore > thresholdZ);
  const maxZ = sorted.reduce((m, s) => Math.max(m, s.zScore), 0);
  return { driftedFeatures: drifted, maxZ: advRound6(maxZ) };
}

// ---------------------------------------------------------------------------
// Champion/challenger comparison
// ---------------------------------------------------------------------------

/** Frozen guardrail metric ids for the comparison (sorted). */
export const ML_COMPARISON_METRICS = [
  "accuracy",
  "brierScore",
  "calibrationGap",
  "precisionAccept",
] as const;
export type MlComparisonMetric = (typeof ML_COMPARISON_METRICS)[number];
export const mlComparisonMetricSchema = z.enum(ML_COMPARISON_METRICS);

/** Per-metric semantics: higher is better vs lower is better. */
export const METRIC_HIGHER_IS_BETTER: Readonly<Record<MlComparisonMetric, boolean>> =
  Object.freeze({
    accuracy: true,
    brierScore: false,
    calibrationGap: false,
    precisionAccept: true,
  });

/**
 * Deterministic champion/challenger comparison over the frozen metric set.
 * The challenger WINS only when it beats the champion STRICTLY on the
 * primary metric (accuracy) and is at least as good on every guardrail
 * (Brier, calibration gap; precision when both defined). Ties never
 * promote. Every outcome carries a machine-readable verdict and
 * per-metric deltas (auditable, never narrative-only).
 */
export const mlComparisonSchema = z
  .object({
    comparisonId: z.string().regex(/^mlcmp_[0-9a-f]{16}$/),
    championArtifactId: z.string().min(3),
    challengerArtifactId: z.string().min(3),
    verdict: z.enum(["challenger_wins", "champion_retained"]),
    reasonCode: z.enum([
      "challenger_wins_all",
      "challenger_loses_primary",
      "challenger_fails_guardrail",
      "challenger_precision_undefined",
    ]),
    accuracyDelta: z.number().finite(),
    brierScoreDelta: z.number().finite(),
    calibrationGapDelta: z.number().finite(),
    precisionDelta: z.number().finite().nullable(),
    championEvidenceHash: z.string().regex(/^[0-9a-f]{16}$/),
    challengerEvidenceHash: z.string().regex(/^[0-9a-f]{16}$/),
  })
  .strict();

export type MlComparison = z.infer<typeof mlComparisonSchema>;

/** Compare two evidence bundles (deterministic; ties never promote). */
export function compareChallengerToChampion(
  champion: OosEvidence,
  challenger: OosEvidence,
): MlComparison {
  const champ = oosEvidenceSchema.parse(champion);
  const chall = oosEvidenceSchema.parse(challenger);
  if (champ.modelArtifactId === chall.modelArtifactId) {
    throw new MlChallengerError("champion and challenger must be different model artifacts");
  }
  const accuracyDelta = advRound6(chall.oosAccuracy - champ.oosAccuracy);
  const brierScoreDelta = advRound6(chall.oosBrierScore - champ.oosBrierScore);
  const calibrationGapDelta = advRound6(chall.oosCalibrationGap - champ.oosCalibrationGap);
  const precisionDelta =
    chall.oosPrecisionAccept === null || champ.oosPrecisionAccept === null
      ? null
      : advRound6(chall.oosPrecisionAccept - champ.oosPrecisionAccept);

  let verdict: "challenger_wins" | "champion_retained";
  let reasonCode: MlComparison["reasonCode"];
  if (chall.oosAccuracy <= champ.oosAccuracy) {
    verdict = "champion_retained";
    reasonCode = "challenger_loses_primary";
  } else if (
    chall.oosBrierScore > champ.oosBrierScore ||
    chall.oosCalibrationGap > champ.oosCalibrationGap
  ) {
    verdict = "champion_retained";
    reasonCode = "challenger_fails_guardrail";
  } else if (champ.oosPrecisionAccept !== null && chall.oosPrecisionAccept === null) {
    verdict = "champion_retained";
    reasonCode = "challenger_precision_undefined";
  } else {
    verdict = "challenger_wins";
    reasonCode = "challenger_wins_all";
  }

  const content = [
    "mlcmp",
    champ.modelArtifactId,
    chall.modelArtifactId,
    verdict,
    reasonCode,
    String(accuracyDelta),
    String(brierScoreDelta),
    String(calibrationGapDelta),
    precisionDelta === null ? "-" : String(precisionDelta),
    oosEvidenceHashFor(champ),
    oosEvidenceHashFor(chall),
  ].join("|");
  return mlComparisonSchema.parse({
    comparisonId: `mlcmp_${advHash16(content)}`,
    championArtifactId: champ.modelArtifactId,
    challengerArtifactId: chall.modelArtifactId,
    verdict,
    reasonCode,
    accuracyDelta,
    brierScoreDelta,
    calibrationGapDelta,
    precisionDelta,
    championEvidenceHash: oosEvidenceHashFor(champ),
    challengerEvidenceHash: oosEvidenceHashFor(chall),
  });
}

// ---------------------------------------------------------------------------
// Production gate (ML stays OFF by default)
// ---------------------------------------------------------------------------

/** Frozen gate configuration thresholds (versioned data, not literals). */
export const mlGateConfigSchema = z
  .object({
    gateConfigVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    minOosSampleSize: z.number().int().min(1),
    minOosAccuracy: z.number().finite().min(0).max(1),
    maxCalibrationGap: z.number().finite().min(0).max(1),
    maxBrierScore: z.number().finite().min(0).max(1),
    maxDriftZ: z.number().finite().positive(),
  })
  .strict();
export type MlGateConfig = z.infer<typeof mlGateConfigSchema>;

/** Machine-readable gate check ids (frozen; sorted). */
export const ML_GATE_CHECKS = [
  "accuracy_above_floor", // OOS accuracy >= minOosAccuracy
  "calibration_within_threshold", // gap and Brier within limits
  "drift_within_threshold", // no feature beyond maxDriftZ
  "evidence_complete", // every evidence field present and schema-valid
  "sample_size_sufficient", // oosSampleSize >= minOosSampleSize
  "walkforward_present", // P09 walk-forward + purge provenance digests
] as const;
export type MlGateCheck = (typeof ML_GATE_CHECKS)[number];
export const mlGateCheckSchema = z.enum(ML_GATE_CHECKS);

export const mlGateCheckResultSchema = z
  .object({
    checkId: mlGateCheckSchema,
    passed: z.boolean(),
    detail: z.string().min(1),
  })
  .strict();
export type MlGateCheckResult = z.infer<typeof mlGateCheckResultSchema>;

/** Full production gate assessment (deterministic; fail-closed). */
export const mlGateAssessmentSchema = z
  .object({
    assessmentId: z.string().regex(/^mlgate_[0-9a-f]{16}$/),
    modelArtifactId: z.string().min(3),
    productionEnabled: z.boolean(),
    checks: z.array(mlGateCheckResultSchema).length(ML_GATE_CHECKS.length),
    evidenceHash: z.string().regex(/^[0-9a-f]{16}$/),
    gateConfigVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    assessedAtUtc: utcInstantSchema,
  })
  .strict()
  .refine(
    (a) => a.productionEnabled === a.checks.every((c) => c.passed),
    {
      message: "productionEnabled must agree with the checks (no forged pass)",
      path: ["productionEnabled"],
    },
  );

export type MlGateAssessment = z.infer<typeof mlGateAssessmentSchema>;

/**
 * Assess the production gate for one model version.
 *
 * ML production is OFF by default and can only be enabled when EVERY check
 * passes with COMPLETE evidence: schema-valid `OosEvidence` (which itself
 * requires training-manifest, walk-forward, purge, calibration and drift
 * fields), sufficient OOS samples, accuracy floor, calibration thresholds
 * and zero drifted features. Any malformed/missing evidence throws
 * (fail closed) — there is no partial-credit gate.
 */
export function assessMlGate(input: {
  evidence: OosEvidence;
  config: MlGateConfig;
  assessedAtUtc: string;
}): MlGateAssessment {
  const evidence = oosEvidenceSchema.parse(input.evidence);
  const config = mlGateConfigSchema.parse(input.config);
  const assessedAtUtc = utcInstantSchema.parse(input.assessedAtUtc);

  const byId = new Map<string, MlGateCheckResult>();
  byId.set("evidence_complete", {
    checkId: "evidence_complete",
    passed: true, // oosEvidenceSchema.parse above would have thrown otherwise
    detail: "evidence schema validated with all required fields",
  });
  byId.set("walkforward_present", {
    checkId: "walkforward_present",
    passed: /^[0-9a-f]{16}$/.test(evidence.walkforwardPlanHash) && /^[0-9a-f]{16}$/.test(evidence.purgeReportHash),
    detail: "P09 walk-forward and purge digests present",
  });
  byId.set("sample_size_sufficient", {
    checkId: "sample_size_sufficient",
    passed: evidence.oosSampleSize >= config.minOosSampleSize,
    detail: `oosSampleSize ${evidence.oosSampleSize} vs min ${config.minOosSampleSize}`,
  });
  byId.set("accuracy_above_floor", {
    checkId: "accuracy_above_floor",
    passed: evidence.oosAccuracy >= config.minOosAccuracy,
    detail: `oosAccuracy ${evidence.oosAccuracy} vs floor ${config.minOosAccuracy}`,
  });
  byId.set("calibration_within_threshold", {
    checkId: "calibration_within_threshold",
    passed:
      evidence.oosCalibrationGap <= config.maxCalibrationGap &&
      evidence.oosBrierScore <= config.maxBrierScore,
    detail: `gap ${evidence.oosCalibrationGap}/${config.maxCalibrationGap}, brier ${evidence.oosBrierScore}/${config.maxBrierScore}`,
  });
  byId.set("drift_within_threshold", {
    checkId: "drift_within_threshold",
    passed:
      evidence.driftedFeatureCount === 0 && evidence.maxFeatureDriftZ <= config.maxDriftZ,
    detail: `drift maxZ ${evidence.maxFeatureDriftZ}/${config.maxDriftZ}, drifted ${evidence.driftedFeatureCount}`,
  });
  const ordered: MlGateCheckResult[] = ML_GATE_CHECKS.map((id) => {
    const found = byId.get(id);
    if (found === undefined) throw new MlChallengerError(`missing gate check ${id}`);
    return found;
  });
  const productionEnabled = ordered.every((c) => c.passed);
  const evidenceHash = oosEvidenceHashFor(evidence);
  const assessmentId = `mlgate_${advHash16(
    [
      "mlgate",
      evidence.modelArtifactId,
      evidenceHash,
      config.gateConfigVersion,
      assessedAtUtc,
      String(productionEnabled),
    ].join("|"),
  )}`;
  return mlGateAssessmentSchema.parse({
    assessmentId,
    modelArtifactId: evidence.modelArtifactId,
    productionEnabled,
    checks: ordered,
    evidenceHash,
    gateConfigVersion: config.gateConfigVersion,
    assessedAtUtc,
  });
}
