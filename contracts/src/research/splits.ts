/**
 * Research-lab data splits (P09-01, ADR-0020 section 1).
 *
 * Deterministic train/validate/test partition of a bar index range with an
 * explicit purge gap (bars, >= 0) separating adjacent sections. Pure function
 * of (barCount, ratios, gapBars, seed): same inputs -> byte-identical plan.
 *
 * Sections are non-overlapping, chronological, forward-only. Every boundary
 * is a bar-open index; labels for a section use bars strictly before its
 * first bar (candle-close semantics). `seed` is recorded provenance the
 * deterministic splitter never consumes.
 */
import { z } from "zod";

export const RESEARCH_SPLIT_ID = "research-splits";
export const RESEARCH_SPLIT_VERSION = "1.0.0";

/** Section names in chronological order (frozen). */
export const RESEARCH_SPLIT_SECTIONS = ["train", "validate", "test"] as const;
export type ResearchSplitSection = (typeof RESEARCH_SPLIT_SECTIONS)[number];

/** One contiguous, inclusive-start/exclusive-end bar index range. */
export const researchSplitRangeSchema = z
  .object({
    section: z.enum(RESEARCH_SPLIT_SECTIONS),
    startBar: z.number().int().min(0),
    endBar: z.number().int().min(0),
  })
  .strict()
  .refine((r) => r.startBar < r.endBar, {
    message: "startBar must be before endBar",
    path: ["endBar"],
  });

export type ResearchSplitRange = z.infer<typeof researchSplitRangeSchema>;
/** Ratio-based split request; ratios sum to 1 (6dp rounding tolerance). */
export const researchSplitRequestSchema = z
  .object({
    barCount: z.number().int().min(3),
    trainRatio: z.number().finite().min(0).max(1),
    validateRatio: z.number().finite().min(0).max(1),
    testRatio: z.number().finite().min(0).max(1),
    gapBars: z.number().int().min(0).default(0),
    minSectionBars: z.number().int().min(1).default(1),
    seed: z.string().min(1),
  })
  .strict()
  .refine(
    (r) => {
      const sum =
        Math.round(r.trainRatio * 1e6) +
        Math.round(r.validateRatio * 1e6) +
        Math.round(r.testRatio * 1e6);
      return sum === 1_000_000;
    },
    { message: "ratios must sum to 1", path: ["testRatio"] },
  )
  .refine((r) => r.trainRatio > 0 && r.validateRatio > 0 && r.testRatio > 0, {
    message: "every section ratio must be > 0 (no empty sections)",
    path: ["trainRatio"],
  });

export type ResearchSplitRequest = z.infer<typeof researchSplitRequestSchema>;

/** Deterministic split plan: three disjoint ranges + surviving gaps. */
export const researchSplitPlanSchema = z
  .object({
    splitterId: z.literal(RESEARCH_SPLIT_ID),
    splitterVersion: z.literal(RESEARCH_SPLIT_VERSION),
    barCount: z.number().int().min(3),
    gapBars: z.number().int().min(0),
    seed: z.string().min(1),
    train: researchSplitRangeSchema,
    validate: researchSplitRangeSchema,
    test: researchSplitRangeSchema,
    purgedBars: z.array(z.number().int().min(0)),
  })
  .strict()
  .refine(
    (p) =>
      p.train.section === "train" &&
      p.validate.section === "validate" &&
      p.test.section === "test",
    { message: "sections must be train/validate/test in order", path: ["validate"] },
  )
  .refine(
    (p) => p.train.endBar <= p.validate.startBar && p.validate.endBar <= p.test.startBar,
    { message: "sections must be chronological and non-overlapping", path: ["test"] },
  )
  .refine((p) => p.test.endBar <= p.barCount, {
    message: "test section must end at or before barCount",
    path: ["test"],
  });

export type ResearchSplitPlan = z.infer<typeof researchSplitPlanSchema>;

export class ResearchSplitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchSplitError";
  }
}

/** Deterministic split: floor train/validate, leftover bars go to TEST. */
export function planResearchSplit(input: ResearchSplitRequest): ResearchSplitPlan {
  const request = researchSplitRequestSchema.parse(input);
  const trainBars = Math.floor(request.barCount * request.trainRatio);
  const validateBars = Math.floor(request.barCount * request.validateRatio);
  if (trainBars < request.minSectionBars || validateBars < request.minSectionBars) {
    throw new ResearchSplitError(
      `split of ${request.barCount} bars violates minSectionBars=${request.minSectionBars}`,
    );
  }
  const testBars = request.barCount - trainBars - validateBars - 2 * request.gapBars;
  if (testBars < request.minSectionBars) {
    throw new ResearchSplitError(
      `split leaves ${testBars} test bars below minSectionBars=${request.minSectionBars}`,
    );
  }
  const train = { section: "train" as const, startBar: 0, endBar: trainBars };
  const validate = {
    section: "validate" as const,
    startBar: trainBars + request.gapBars,
    endBar: trainBars + request.gapBars + validateBars,
  };
  const test = {
    section: "test" as const,
    startBar: trainBars + request.gapBars + validateBars + request.gapBars,
    endBar: trainBars + request.gapBars + validateBars + request.gapBars + testBars,
  };
  const purgedBars: number[] = [];
  for (let b = train.endBar; b < validate.startBar; b += 1) purgedBars.push(b);
  for (let b = validate.endBar; b < test.startBar; b += 1) purgedBars.push(b);
  return researchSplitPlanSchema.parse({
    splitterId: RESEARCH_SPLIT_ID,
    splitterVersion: RESEARCH_SPLIT_VERSION,
    barCount: request.barCount,
    gapBars: request.gapBars,
    seed: request.seed,
    train,
    validate,
    test,
    purgedBars,
  });
}

/** Slice bar indices for one section (half-open [startBar, endBar)). */
export function barsOfSection(plan: ResearchSplitPlan, section: ResearchSplitSection): number[] {
  const parsed = researchSplitPlanSchema.parse(plan);
  const range = parsed[section];
  const out: number[] = [];
  for (let b = range.startBar; b < range.endBar; b += 1) out.push(b);
  return out;
}

/** Canonical serialization (hash input; pipe-joined, newline-free). */
export function serializeResearchSplitCanonical(plan: ResearchSplitPlan): string {
  const p = researchSplitPlanSchema.parse(plan);
  const range = (r: ResearchSplitRange): string => `${r.section}:${r.startBar}-${r.endBar}`;
  return [
    "rsplit",
    RESEARCH_SPLIT_ID,
    RESEARCH_SPLIT_VERSION,
    String(p.barCount),
    String(p.gapBars),
    p.seed,
    range(p.train),
    range(p.validate),
    range(p.test),
  ].join("|");
}

