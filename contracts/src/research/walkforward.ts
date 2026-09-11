/**
 * Walk-forward evaluation (P09-02, ADR-0020 section 2).
 *
 * Deterministic rolling/expanding folds over a bar index range. Pure
 * function of (barCount, trainBars, testBars, stepBars, mode, gapBars):
 * same inputs -> byte-identical folds. Forward-only; test segments never
 * overlap; train segments precede their test segment with gapBars purged
 * bars between them.
 */
import { z } from "zod";

import {
  RESEARCH_SPLIT_SECTIONS,
  researchSplitRangeSchema,
} from "./splits";

export const RESEARCH_WALKFORWARD_ID = "research-walkforward";
export const RESEARCH_WALKFORWARD_VERSION = "1.0.0";

export const WALKFORWARD_MODES = ["rolling", "expanding"] as const;
export type WalkforwardMode = (typeof WALKFORWARD_MODES)[number];

export const walkforwardRequestSchema = z
  .object({
    barCount: z.number().int().min(3),
    trainBars: z.number().int().min(1),
    testBars: z.number().int().min(1),
    stepBars: z.number().int().min(1),
    mode: z.enum(WALKFORWARD_MODES),
    gapBars: z.number().int().min(0).default(0),
    minFolds: z.number().int().min(1).default(1),
    seed: z.string().min(1),
  })
  .strict()
  .refine((r) => r.trainBars + r.gapBars + r.testBars <= r.barCount, {
    message: "one fold (train+gap+test) must fit inside barCount",
    path: ["testBars"],
  });

export type WalkforwardRequest = z.infer<typeof walkforwardRequestSchema>;

/** One fold: disjoint train/test ranges plus the purged gap bars. */
export const walkforwardFoldSchema = z
  .object({
    foldIndex: z.number().int().min(0),
    train: researchSplitRangeSchema,
    test: researchSplitRangeSchema,
    purgedBars: z.array(z.number().int().min(0)),
  })
  .strict()
  .refine((f) => f.train.endBar <= f.test.startBar, {
    message: "fold train must precede fold test",
    path: ["test"],
  });

export type WalkforwardFold = z.infer<typeof walkforwardFoldSchema>;

export const walkforwardPlanSchema = z
  .object({
    splitterId: z.literal(RESEARCH_WALKFORWARD_ID),
    splitterVersion: z.literal(RESEARCH_WALKFORWARD_VERSION),
    barCount: z.number().int().min(3),
    mode: z.enum(WALKFORWARD_MODES),
    stepBars: z.number().int().min(1),
    gapBars: z.number().int().min(0),
    seed: z.string().min(1),
    folds: z.array(walkforwardFoldSchema).min(1),
  })
  .strict();

export type WalkforwardPlan = z.infer<typeof walkforwardPlanSchema>;

export class WalkforwardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalkforwardError";
  }
}

/** Section labels reused from splits (train/test); validate unused here. */
export const WALKFORWARD_SECTIONS = RESEARCH_SPLIT_SECTIONS;


/** Deterministic folds: step the test window, grow or slide the train. */
export function planWalkforward(input: WalkforwardRequest): WalkforwardPlan {
  const request = walkforwardRequestSchema.parse(input);
  const folds: WalkforwardFold[] = [];
  let anchor = 0;
  let foldIndex = 0;
  for (;;) {
    const trainStart = request.mode === "expanding" ? 0 : anchor;
    const trainEnd = anchor + request.trainBars;
    const testStart = trainEnd + request.gapBars;
    const testEnd = testStart + request.testBars;
    if (testEnd > request.barCount) break;
    const purgedBars: number[] = [];
    for (let b = trainEnd; b < testStart; b += 1) purgedBars.push(b);
    folds.push(
      walkforwardFoldSchema.parse({
        foldIndex,
        train: { section: "train", startBar: trainStart, endBar: trainEnd },
        test: { section: "test", startBar: testStart, endBar: testEnd },
        purgedBars,
      }),
    );
    foldIndex += 1;
    anchor += request.stepBars;
    if (foldIndex > 10_000) {
      throw new WalkforwardError("walk-forward plan exceeds 10000 folds (check stepBars)");
    }
  }
  if (folds.length < request.minFolds) {
    throw new WalkforwardError(
      `walk-forward yields ${folds.length} folds below minFolds=${request.minFolds}`,
    );
  }
  return walkforwardPlanSchema.parse({
    splitterId: RESEARCH_WALKFORWARD_ID,
    splitterVersion: RESEARCH_WALKFORWARD_VERSION,
    barCount: request.barCount,
    mode: request.mode,
    stepBars: request.stepBars,
    gapBars: request.gapBars,
    seed: request.seed,
    folds,
  });
}

/** Canonical serialization (hash input; pipe-joined, newline-free). */
export function serializeWalkforwardCanonical(plan: WalkforwardPlan): string {
  const p = walkforwardPlanSchema.parse(plan);
  const head = [
    "wforward",
    RESEARCH_WALKFORWARD_ID,
    RESEARCH_WALKFORWARD_VERSION,
    String(p.barCount),
    p.mode,
    String(p.stepBars),
    String(p.gapBars),
    p.seed,
  ].join("|");
  const folds = p.folds
    .map((f) => `fold${f.foldIndex}:train:${f.train.startBar}-${f.train.endBar}:test:${f.test.startBar}-${f.test.endBar}`)
    .join("|");
  return `${head}|${folds}`;
}
