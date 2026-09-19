/**
 * Online/adaptive research — shadow experiments (P18-05, ADR-0032 section 5).
 *
 * Shadow/adaptive scoring experiments that can update weights ONLY in
 * research or paper mode until promotion. Frozen semantics:
 * - VERSIONED WEIGHT STATES: an adaptive experiment holds a versioned weight
 *   vector (`weightsVersion` + the vector). Every update produces a NEW
 *   version; historical versions are immutable (append-only).
 * - REPLAYABLE: every weight update is an `AdaptiveWeightUpdate` event with
 *   a deterministic content hash; the whole experiment can be replayed from
 *   the initial state + the event list (idempotent fold).
 * - MODE GATING: experiments run in `research` or `paper` mode ONLY. A
 *   `live` mode request fails at the schema boundary — online changes NEVER
 *   silently affect live behavior (acceptance criterion; ADR-0005).
 * - PROMOTION: an experiment may only leave shadow mode through the P18-02
 *   gate (ML champion gate) via an explicit promotion event that must
 *   reference the gate assessment id; retirement is terminal.
 * - DETERMINISTIC: same initial state + same events -> identical final
 *   state (fold is a pure function). No wall clock, no randomness, no
 *   broker access (ADR-0003/0004/0005).
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";
import { advHash16, advRound6 } from "./util";

export const ADAPTIVE_ID = "adaptive-research";
export const ADAPTIVE_VERSION = "1.0.0";

export class AdaptiveResearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdaptiveResearchError";
  }
}

/** Experiment modes; `live` is intentionally ABSENT (schema refuses it). */
export const ADAPTIVE_MODES = ["research", "paper"] as const;
export type AdaptiveMode = (typeof ADAPTIVE_MODES)[number];
export const adaptiveModeSchema = z.enum(ADAPTIVE_MODES);

/** Weight vector: component id -> weight in [0, 1]. */
export const weightVectorSchema = z
  .record(z.string().min(2), z.number().finite().min(0).max(1))
  .refine((v) => Object.keys(v).length >= 1, {
    message: "weight vector must contain at least one component",
  });
export type WeightVector = z.infer<typeof weightVectorSchema>;

/** Canonical weight-vector serialization (sorted keys; hash input). */
export function serializeWeightVector(v: WeightVector): string {
  const keys = Object.keys(v).sort();
  return keys.map((k) => `${k}=${String(v[k])}`).join(",");
}

/** Experiment state (one versioned weight state + mode + status). */
export const adaptiveExperimentSchema = z
  .object({
    experimentId: z.string().min(3).max(64),
    weightsVersion: z.number().int().min(1),
    weights: weightVectorSchema,
    mode: adaptiveModeSchema,
    status: z.enum(["shadow", "promoted", "retired"]),
    promotedFromGateAssessmentId: z.string().regex(/^mlgate_[0-9a-f]{16}$/).nullable(),
    createdAtUtc: utcInstantSchema,
    updatedAtUtc: utcInstantSchema,
  })
  .strict();
export type AdaptiveExperiment = z.infer<typeof adaptiveExperimentSchema>;

/**
 * One weight-update event. The event stores the RESULT vector (not the raw
 * gradient) so replay needs no arithmetic reconstruction.
 */
export const adaptiveWeightUpdateSchema = z
  .object({
    eventId: z.string().regex(/^adup_[0-9a-f]{16}$/),
    experimentId: z.string().min(3).max(64),
    weightsVersion: z.number().int().min(2),
    weights: weightVectorSchema,
    learningRate: z.number().finite().gt(0).lte(1),
    appliedAtUtc: utcInstantSchema,
  })
  .strict();
export type AdaptiveWeightUpdate = z.infer<typeof adaptiveWeightUpdateSchema>;

/** Compute one bounded online step toward a target vector. */
export function stepWeights(
  current: WeightVector,
  target: WeightVector,
  learningRate: number,
): WeightVector {
  if (!Number.isFinite(learningRate) || learningRate <= 0 || learningRate > 1) {
    throw new AdaptiveResearchError(`learningRate must be in (0,1]: ${learningRate}`);
  }
  const currentKeys = new Set(Object.keys(current));
  const targetKeys = new Set(Object.keys(target));
  if (currentKeys.size !== targetKeys.size || [...currentKeys].some((k) => !targetKeys.has(k))) {
    throw new AdaptiveResearchError(
      "target vector must have exactly the same component ids as current",
    );
  }
  const out: Record<string, number> = {};
  for (const k of Object.keys(current)) {
    const stepped = current[k] + learningRate * (target[k] - current[k]);
    out[k] = advRound6(Math.min(1, Math.max(0, stepped)));
  }
  return weightVectorSchema.parse(out);
}

/** Update-content schema (eventId excluded while the id is being derived). */
export const adaptiveWeightUpdateContentSchema = adaptiveWeightUpdateSchema.omit({
  eventId: true,
});
export type AdaptiveWeightUpdateContent = z.infer<typeof adaptiveWeightUpdateContentSchema>;

/** Canonical update serialization (hash input; id not part of content). */
export function serializeWeightUpdateCanonical(u: AdaptiveWeightUpdateContent): string {
  const p = adaptiveWeightUpdateContentSchema.parse(u);
  return [
    "adup",
    p.experimentId,
    String(p.weightsVersion),
    serializeWeightVector(p.weights),
    String(p.learningRate),
    p.appliedAtUtc,
  ].join("|");
}

/** Deterministic content-addressed update event id. */
export function weightUpdateIdFor(u: AdaptiveWeightUpdateContent): string {
  return `adup_${advHash16(serializeWeightUpdateCanonical(u))}`;
}

// ---------------------------------------------------------------------------
// Promotion / retirement events (explicit, evidence-linked)
// ---------------------------------------------------------------------------

/**
 * A promotion event: shadow -> promoted. REQUIRED: the P18-02 gate
 * assessment id that passed (`mlgate_...`). A promotion without a passing
 * gate assessment cannot exist at this boundary.
 */
export const adaptivePromotionEventSchema = z
  .object({
    eventId: z.string().regex(/^adpro_[0-9a-f]{16}$/),
    experimentId: z.string().min(3).max(64),
    gateAssessmentId: z.string().regex(/^mlgate_[0-9a-f]{16}$/),
    promotedAtUtc: utcInstantSchema,
  })
  .strict();
export type AdaptivePromotionEvent = z.infer<typeof adaptivePromotionEventSchema>;

/** A retirement event: shadow/promoted -> retired (terminal). */
export const adaptiveRetireEventSchema = z
  .object({
    eventId: z.string().regex(/^adret_[0-9a-f]{16}$/),
    experimentId: z.string().min(3).max(64),
    reason: z.string().min(1).max(280),
    retiredAtUtc: utcInstantSchema,
  })
  .strict();
export type AdaptiveRetireEvent = z.infer<typeof adaptiveRetireEventSchema>;

/** The experiment event union (weight updates, promotions, retirements). */
export const adaptiveEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("weight_update"),
    update: adaptiveWeightUpdateSchema,
  }),
  z.object({
    kind: z.literal("promote"),
    promotion: adaptivePromotionEventSchema,
  }),
  z.object({
    kind: z.literal("retire"),
    retirement: adaptiveRetireEventSchema,
  }),
]);
export type AdaptiveEvent = z.infer<typeof adaptiveEventSchema>;

/**
 * Fold events over an experiment state. Idempotent and deterministic: the
 * same initial state + same ordered events always yield the same result.
 * Rules enforced during fold (fail closed on violation):
 * - weight updates must bump `weightsVersion` by exactly 1 and reference
 *   the same experimentId;
 * - events must be strictly ascending by their UTC instant;
 * - promotions require status `shadow`; retirement requires a non-terminal
 *   status; retired (terminal) accepts no further events.
 */
export function replayAdaptiveExperiment(
  initial: AdaptiveExperiment,
  events: readonly AdaptiveEvent[],
): AdaptiveExperiment {
  let state = adaptiveExperimentSchema.parse(initial);
  let lastAtUtc = state.updatedAtUtc;
  for (const raw of events) {
    const e = adaptiveEventSchema.parse(raw);
    const eventAtUtc =
      e.kind === "weight_update"
        ? e.update.appliedAtUtc
        : e.kind === "promote"
          ? e.promotion.promotedAtUtc
          : e.retirement.retiredAtUtc;
    if (!(eventAtUtc > lastAtUtc)) {
      throw new AdaptiveResearchError("events must be strictly ascending by UTC instant");
    }
    lastAtUtc = eventAtUtc;
    if (e.kind === "weight_update") {
      if (state.status !== "shadow") {
        throw new AdaptiveResearchError(
          `weight updates are only allowed while shadow (state: ${state.status})`,
        );
      }
      if (e.update.experimentId !== state.experimentId) {
        throw new AdaptiveResearchError("update experimentId must match the experiment");
      }
      if (e.update.weightsVersion !== state.weightsVersion + 1) {
        throw new AdaptiveResearchError(
          `update must bump weightsVersion to ${state.weightsVersion + 1}, got ${e.update.weightsVersion}`,
        );
      }
      state = adaptiveExperimentSchema.parse({
        ...state,
        weightsVersion: e.update.weightsVersion,
        weights: e.update.weights,
        updatedAtUtc: e.update.appliedAtUtc,
      });
    } else if (e.kind === "promote") {
      if (state.status !== "shadow") {
        throw new AdaptiveResearchError(
          `promotion requires shadow status (state: ${state.status})`,
        );
      }
      if (e.promotion.experimentId !== state.experimentId) {
        throw new AdaptiveResearchError("promotion experimentId must match the experiment");
      }
      state = adaptiveExperimentSchema.parse({
        ...state,
        status: "promoted",
        promotedFromGateAssessmentId: e.promotion.gateAssessmentId,
        updatedAtUtc: e.promotion.promotedAtUtc,
      });
    } else {
      if (state.status === "retired") {
        throw new AdaptiveResearchError("retired experiments are terminal");
      }
      if (e.retirement.experimentId !== state.experimentId) {
        throw new AdaptiveResearchError("retirement experimentId must match the experiment");
      }
      state = adaptiveExperimentSchema.parse({
        ...state,
        status: "retired",
        updatedAtUtc: e.retirement.retiredAtUtc,
      });
    }
  }
  return state;
}

/** Open a new shadow experiment (version 1; research or paper mode only). */
export function openAdaptiveExperiment(input: {
  experimentId: string;
  weights: WeightVector;
  mode: AdaptiveMode;
  createdAtUtc: string;
}): AdaptiveExperiment {
  return adaptiveExperimentSchema.parse({
    experimentId: input.experimentId,
    weightsVersion: 1,
    weights: weightVectorSchema.parse(input.weights),
    mode: adaptiveModeSchema.parse(input.mode),
    status: "shadow",
    promotedFromGateAssessmentId: null,
    createdAtUtc: utcInstantSchema.parse(input.createdAtUtc),
    updatedAtUtc: utcInstantSchema.parse(input.createdAtUtc),
  });
}

/**
 * Build the next weight-update event from the current state + target
 * vector (bounded online step). The caller applies it via
 * `replayAdaptiveExperiment` — the update itself is a pure builder.
 */
export function buildWeightUpdate(
  experiment: AdaptiveExperiment,
  target: WeightVector,
  learningRate: number,
  appliedAtUtc: string,
): AdaptiveEvent {
  const state = adaptiveExperimentSchema.parse(experiment);
  if (state.status !== "shadow") {
    throw new AdaptiveResearchError(
      `weight updates are only allowed while shadow (state: ${state.status})`,
    );
  }
  const weights = stepWeights(state.weights, target, learningRate);
  const content = adaptiveWeightUpdateContentSchema.parse({
    experimentId: state.experimentId,
    weightsVersion: state.weightsVersion + 1,
    weights,
    learningRate,
    appliedAtUtc: utcInstantSchema.parse(appliedAtUtc),
  });
  const update: AdaptiveWeightUpdate = adaptiveWeightUpdateSchema.parse({
    ...content,
    eventId: weightUpdateIdFor(content),
  });
  return { kind: "weight_update", update };
}
