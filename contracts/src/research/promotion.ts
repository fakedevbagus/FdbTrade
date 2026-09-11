/**
 * Strategy promotion registry (P09-05, ADR-0020 section 5).
 *
 * Candidate -> challenger -> champion lifecycle with explicit evidence
 * requirements (walk-forward folds, purge/embargo report, stress summary)
 * and a rollback pointer to the previous champion. State transitions are
 * append-only events; terminal states never transition out. No live order
 * authority anywhere in this module (ADR-0005).
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";

export const PROMOTION_REGISTRY_ID = "strategy-promotion-registry";
export const PROMOTION_REGISTRY_VERSION = "1.0.0";

export const PROMOTION_STATES = ["candidate", "challenger", "champion", "retired", "rejected"] as const;
export type PromotionState = (typeof PROMOTION_STATES)[number];

export const promotionStateSchema = z.enum(PROMOTION_STATES);

export const PROMOTION_TERMINAL_STATES: readonly PromotionState[] = Object.freeze([
  "retired",
  "rejected",
]);

/** Evidence bundle required before a candidate may become a challenger. */
export const promotionEvidenceSchema = z
  .object({
    splitPlanHash: z.string().regex(/^[0-9a-f]{64}$/),
    walkforwardPlanHash: z.string().regex(/^[0-9a-f]{64}$/),
    purgeReportHash: z.string().regex(/^[0-9a-f]{64}$/),
    stressSummaryHash: z.string().regex(/^[0-9a-f]{64}$/),
    oosNetReturn: z.number().finite(),
    oosMaxDrawdown: z.number().finite().min(0),
    walkforwardMedianNetReturn: z.number().finite(),
  })
  .strict();

export type PromotionEvidence = z.infer<typeof promotionEvidenceSchema>;

export const promotionTransitionSchema = z
  .object({
    strategyId: z.string().min(1),
    from: promotionStateSchema,
    to: promotionStateSchema,
    atUtc: utcInstantSchema,
    reason: z.string().min(1).max(280),
  })
  .strict()
  .refine((t) => t.from !== t.to, { message: "from and to must differ", path: ["to"] })
  .refine((t) => !PROMOTION_TERMINAL_STATES.includes(t.from), {
    message: "terminal states are absorbing (no transitions out)",
    path: ["from"],
  });

export type PromotionTransition = z.infer<typeof promotionTransitionSchema>;

export const promotionRecordSchema = z
  .object({
    strategyId: z.string().min(1),
    strategyVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    configVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    state: promotionStateSchema,
    evidence: promotionEvidenceSchema.nullable(),
    previousChampionId: z.string().min(1).nullable(),
    transitions: z.array(promotionTransitionSchema),
  })
  .strict()
  .refine((r) => r.transitions.every((t) => t.strategyId === r.strategyId), {
    message: "transition strategyId must match the record",
    path: ["transitions"],
  });

export type PromotionRecord = z.infer<typeof promotionRecordSchema>;

export class PromotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromotionError";
  }
}

/** Allowed transitions (forward-only lifecycle, no skips, no resurrections). */
const ALLOWED: Readonly<Record<PromotionState, readonly PromotionState[]>> = Object.freeze({
  candidate: Object.freeze(["challenger", "rejected"]) as readonly PromotionState[],
  challenger: Object.freeze(["champion", "rejected"]) as readonly PromotionState[],
  champion: Object.freeze(["retired"]) as readonly PromotionState[],
  retired: Object.freeze([]) as readonly PromotionState[],
  rejected: Object.freeze([]) as readonly PromotionState[],
});

/** Open a candidate record (no evidence yet; evidence arrives before review). */
export function openCandidate(input: {
  strategyId: string;
  strategyVersion: string;
  configVersion: string;
}): PromotionRecord {
  return promotionRecordSchema.parse({
    ...input,
    state: "candidate",
    evidence: null,
    previousChampionId: null,
    transitions: [],
  });
}

/** Attach the evidence bundle (candidate/challenger only; terminal rejects). */
export function attachEvidence(record: PromotionRecord, evidence: PromotionEvidence): PromotionRecord {
  const parsed = promotionRecordSchema.parse(record);
  if (PROMOTION_TERMINAL_STATES.includes(parsed.state)) {
    throw new PromotionError(`cannot attach evidence in terminal state ${parsed.state}`);
  }
  return promotionRecordSchema.parse({
    ...parsed,
    evidence: promotionEvidenceSchema.parse(evidence),
  });
}

/** Apply one lifecycle transition (validates the move and appends the log). */
export function applyPromotionTransition(
  record: PromotionRecord,
  transition: PromotionTransition,
): PromotionRecord {
  const parsed = promotionRecordSchema.parse(record);
  const t = promotionTransitionSchema.parse(transition);
  if (t.strategyId !== parsed.strategyId) {
    throw new PromotionError("transition strategyId must match the record");
  }
  if (parsed.state !== t.from) {
    throw new PromotionError(`record is ${parsed.state}, cannot apply from=${t.from}`);
  }
  if (!ALLOWED[t.from].includes(t.to)) {
    throw new PromotionError(`transition ${t.from} -> ${t.to} is not allowed`);
  }
  if ((t.to === "challenger" || t.to === "champion") && parsed.evidence === null) {
    throw new PromotionError(`promotion to ${t.to} requires attached evidence`);
  }
  const last = parsed.transitions[parsed.transitions.length - 1];
  if (last !== undefined && !(t.atUtc > last.atUtc)) {
    throw new PromotionError("transitions must be strictly ascending by atUtc");
  }
  return promotionRecordSchema.parse({
    ...parsed,
    state: t.to,
    previousChampionId:
      t.to === "champion" && parsed.previousChampionId === null
        ? parsed.strategyId
        : parsed.previousChampionId,
    transitions: [...parsed.transitions, t],
  });
}
