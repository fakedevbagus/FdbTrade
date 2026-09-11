/**
 * Purged/embargoed validation (P09-03, ADR-0020 section 3).
 *
 * Labels computed over a forward horizon leak when training bars sit inside
 * another sample's label window. `purgeOverlapping` drops every training bar
 * whose [bar, bar + horizonBars) window touches the test range (purging),
 * and `applyEmbargo` additionally drops the `embargoBars` bars immediately
 * after each test range (embargo). Pure index math; deterministic.
 */
import { z } from "zod";

import { researchSplitRangeSchema } from "./splits";

export const RESEARCH_PURGE_ID = "research-purge-embargo";
export const RESEARCH_PURGE_VERSION = "1.0.0";

export const purgeRequestSchema = z
  .object({
    barCount: z.number().int().min(2),
    trainStartBar: z.number().int().min(0),
    trainEndBar: z.number().int().min(0),
    testStartBar: z.number().int().min(0),
    testEndBar: z.number().int().min(0),
    horizonBars: z.number().int().min(1),
    embargoBars: z.number().int().min(0).default(0),
  })
  .strict()
  .refine((r) => r.trainStartBar < r.trainEndBar, {
    message: "trainStartBar must be before trainEndBar",
    path: ["trainEndBar"],
  })
  .refine((r) => r.testStartBar < r.testEndBar, {
    message: "testStartBar must be before testEndBar",
    path: ["testEndBar"],
  })
  .refine((r) => r.trainEndBar <= r.testStartBar, {
    message: "train must precede test (forward-only)",
    path: ["testStartBar"],
  })
  .refine((r) => r.testEndBar <= r.barCount, {
    message: "testEndBar must be within barCount",
    path: ["testEndBar"],
  });

export type PurgeRequest = z.infer<typeof purgeRequestSchema>;

export const purgeReportSchema = z
  .object({
    purgerId: z.literal(RESEARCH_PURGE_ID),
    purgerVersion: z.literal(RESEARCH_PURGE_VERSION),
    train: researchSplitRangeSchema,
    test: researchSplitRangeSchema,
    horizonBars: z.number().int().min(1),
    embargoBars: z.number().int().min(0),
    purgedTrainBars: z.array(z.number().int().min(0)),
    embargoedBars: z.array(z.number().int().min(0)),
    keptTrainBars: z.array(z.number().int().min(0)),
  })
  .strict();

export type PurgeReport = z.infer<typeof purgeReportSchema>;

export class PurgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurgeError";
  }
}

/** Purge + embargo one train/test pair (deterministic index math). */
export function purgeAndEmbargo(input: PurgeRequest): PurgeReport {
  const r = purgeRequestSchema.parse(input);
  const purgedTrainBars: number[] = [];
  const keptTrainBars: number[] = [];
  for (let b = r.trainStartBar; b < r.trainEndBar; b += 1) {
    if (b + r.horizonBars > r.testStartBar) purgedTrainBars.push(b);
    else keptTrainBars.push(b);
  }
  const embargoedBars: number[] = [];
  for (let b = r.testEndBar; b < Math.min(r.barCount, r.testEndBar + r.embargoBars); b += 1) {
    embargoedBars.push(b);
  }
  return purgeReportSchema.parse({
    purgerId: RESEARCH_PURGE_ID,
    purgerVersion: RESEARCH_PURGE_VERSION,
    train: { section: "train", startBar: r.trainStartBar, endBar: r.trainEndBar },
    test: { section: "test", startBar: r.testStartBar, endBar: r.testEndBar },
    horizonBars: r.horizonBars,
    embargoBars: r.embargoBars,
    purgedTrainBars,
    embargoedBars,
    keptTrainBars,
  });
}
