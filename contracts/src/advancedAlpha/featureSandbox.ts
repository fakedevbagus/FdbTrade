/**
 * Advanced feature research sandbox (P18-06, ADR-0032 section 6).
 *
 * Controlled experiments for order-flow proxies, session microstructure,
 * volatility term structure, macro/event features and alternative data
 * WHEN LICENSED. Frozen semantics:
 * - SOURCE/LICENSING NOTE: every experiment records its data source with a
 *   P02-05-style license note (verified requires an evidence URL, else
 *   unverified/synthetic). NO DATA SOURCE WITHOUT PROVENANCE: the schema
 *   refuses an experiment whose source note is missing (fail closed).
 * - HYPOTHESIS: every experiment carries a stated hypothesis (>= 20 chars
 *   — no empty science), because unguided feature mining is snooping.
 * - FEATURES/PERIOD/OOS RESULT: the experiment pins the feature ids it
 *   tests, the research period (inclusive/exclusive UTC), the P09 split
 *   plan digest and the OOS result (accuracy + whether it beat the
 *   baseline). An experiment without an OOS result field is a draft; the
 *   schema validates the draft separately (cannot present as concluded).
 * - ALTERNATIVE DATA gating: alternative-data sources must be explicitly
 *   LICENSED (`licensed: true` + license note); unlicensed alternative
 *   data cannot be sandboxed — fail closed (non-goal compliance).
 * - Deterministic; UTC; no clock/random/broker access (ADR-0003/0004/0005).
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";
import { advHash16, advRound6 } from "./util";

export const FEATURE_SANDBOX_ID = "feature-research-sandbox";
export const FEATURE_SANDBOX_VERSION = "1.0.0";

export class FeatureSandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeatureSandboxError";
  }
}

/** Experiment families (frozen; adding a family needs an ADR). */
export const SANDBOX_FAMILIES = [
  "order_flow_proxy", // tick/volume imbalance proxies (provider-volume aware)
  "session_microstructure", // per-session spread/range/volatility behavior
  "volatility_term_structure", // multi-timeframe volatility relationships
  "macro_event", // scheduled macro/event proximity features
  "alternative_data", // third-party data WHEN LICENSED (gated)
] as const;
export type SandboxFamily = (typeof SANDBOX_FAMILIES)[number];
export const sandboxFamilySchema = z.enum(SANDBOX_FAMILIES);

/** License statuses (P02-05 dataset semantics mirrored). */
export const SANDBOX_LICENSE_STATUSES = ["verified", "unverified", "synthetic"] as const;
export type SandboxLicenseStatus = (typeof SANDBOX_LICENSE_STATUSES)[number];
export const sandboxLicenseStatusSchema = z.enum(SANDBOX_LICENSE_STATUSES);

/**
 * Source/licensing note (provenance, no credentials). A `verified` claim
 * REQUIRES an evidence URL — enforced, not trusted (P02-05 semantics).
 */
export const sandboxSourceNoteSchema = z
  .object({
    /** Human-readable data source description (docs, not credentials). */
    source: z.string().min(1),
    status: sandboxLicenseStatusSchema,
    /** Evidence URL required when verified; else null. */
    evidenceUrl: z.string().url().nullable(),
    /** Whether this source grants redistribution/research rights. */
    licensed: z.boolean(),
    /** Free-text note (redistribution constraints, etc.). */
    note: z.string().min(0),
  })
  .strict()
  .superRefine((n, ctx) => {
    if (n.status === "verified" && n.evidenceUrl === null) {
      ctx.addIssue({
        code: "custom",
        path: ["evidenceUrl"],
        message: "verified source claims require an evidenceUrl",
      });
    }
  });
export type SandboxSourceNote = z.infer<typeof sandboxSourceNoteSchema>;


/** OOS result: what the experiment concluded (draft = null result). */
export const sandboxOosResultSchema = z
  .object({
    /** OOS accuracy of a model using the experimental features. */
    oosAccuracy: z.number().finite().min(0).max(1),
    /** Baseline accuracy WITHOUT the experimental features. */
    baselineOosAccuracy: z.number().finite().min(0).max(1),
    /** Whether the experiment beat its baseline (computed, not asserted). */
    beatBaseline: z.boolean(),
    /** OOS sample size behind both numbers. */
    oosSampleSize: z.number().int().min(1),
  })
  .strict()
  .refine((r) => r.beatBaseline === r.oosAccuracy > r.baselineOosAccuracy, {
    message: "beatBaseline must equal (oosAccuracy > baselineOosAccuracy)",
    path: ["beatBaseline"],
  });
export type SandboxOosResult = z.infer<typeof sandboxOosResultSchema>;

/** Build the OOS result (beatBaseline computed, never asserted). */
export function buildOosResult(input: {
  oosAccuracy: number;
  baselineOosAccuracy: number;
  oosSampleSize: number;
}): SandboxOosResult {
  return sandboxOosResultSchema.parse({
    oosAccuracy: input.oosAccuracy,
    baselineOosAccuracy: input.baselineOosAccuracy,
    beatBaseline: input.oosAccuracy > input.baselineOosAccuracy,
    oosSampleSize: input.oosSampleSize,
  });
}


/**
 * One sandbox experiment. `concludedAtUtc` + `oosResult` travel together:
 * a concluded experiment MUST have a result; a draft has neither.
 */
export const sandboxExperimentSchema = z
  .object({
    experimentId: z.string().regex(/^sbx_[0-9a-f]{16}$/),
    family: sandboxFamilySchema,
    /** Stated hypothesis (>= 20 chars: no unguided feature mining). */
    hypothesis: z.string().min(20).max(1000),
    /** Feature ids under test (P03 feature lineage: id@version). */
    features: z
      .array(z.string().regex(/^[a-z0-9._-]+@\d+\.\d+\.\d+$/))
      .min(1),
    /** Research period (inclusive start, exclusive end, UTC). */
    periodStartUtc: utcInstantSchema,
    periodEndUtc: utcInstantSchema,
    /** P09 split plan digest (OOS boundary provenance). */
    splitPlanHash: z.string().regex(/^[0-9a-f]{16}$/),
    /** Source/licensing provenance (required; no sourceless experiment). */
    source: sandboxSourceNoteSchema,
    /** OOS result (null = draft, not yet concluded). */
    oosResult: sandboxOosResultSchema.nullable(),
    /** UTC instant the experiment was concluded (null while draft). */
    concludedAtUtc: utcInstantSchema.nullable(),
    createdAtUtc: utcInstantSchema,
  })
  .strict()
  .refine((e) => e.periodStartUtc < e.periodEndUtc, {
    message: "periodStartUtc must be before periodEndUtc",
    path: ["periodEndUtc"],
  })
  .refine(
    (e) =>
      (e.oosResult === null && e.concludedAtUtc === null) ||
      (e.oosResult !== null && e.concludedAtUtc !== null),
    {
      message: "oosResult and concludedAtUtc must both be present or both be null",
      path: ["oosResult"],
    },
  )
  .superRefine((e, ctx) => {
    // ALTERNATIVE-DATA GATE: alternative_data experiments must be licensed.
    if (e.family === "alternative_data" && !e.source.licensed) {
      ctx.addIssue({
        code: "custom",
        path: ["source", "licensed"],
        message: "alternative_data experiments require an explicitly licensed source",
      });
    }
  });

export type SandboxExperiment = z.infer<typeof sandboxExperimentSchema>;

/** Content fields the experiment hash covers (hash excluded). */
export type SandboxExperimentContent = Omit<SandboxExperiment, "experimentId">;

/** Canonical serialization (hash input; sorted feature list). */
export function serializeSandboxExperimentCanonical(e: SandboxExperimentContent): string {
  const features = [...e.features].sort().join(",");
  return [
    "sbx",
    e.family,
    e.hypothesis,
    features,
    e.periodStartUtc,
    e.periodEndUtc,
    e.splitPlanHash,
    e.source.source,
    e.source.status,
    e.source.evidenceUrl ?? "-",
    String(e.source.licensed),
    e.oosResult === null
      ? "-"
      : [
          String(e.oosResult.oosAccuracy),
          String(e.oosResult.baselineOosAccuracy),
          String(e.oosResult.beatBaseline),
          String(e.oosResult.oosSampleSize),
        ].join(":"),
    e.concludedAtUtc ?? "-",
    e.createdAtUtc,
  ].join("|");
}

/** Deterministic content-addressed experiment id. */
export function sandboxExperimentIdFor(e: SandboxExperimentContent): string {
  return `sbx_${advHash16(serializeSandboxExperimentCanonical(e))}`;
}

/** Open a DRAFT experiment (no result yet; source provenance required). */
export function openSandboxExperiment(input: {
  family: SandboxFamily;
  hypothesis: string;
  features: string[];
  periodStartUtc: string;
  periodEndUtc: string;
  splitPlanHash: string;
  source: SandboxSourceNote;
  createdAtUtc: string;
}): SandboxExperiment {
  const content: SandboxExperimentContent = {
    family: input.family,
    hypothesis: input.hypothesis,
    features: input.features,
    periodStartUtc: utcInstantSchema.parse(input.periodStartUtc),
    periodEndUtc: utcInstantSchema.parse(input.periodEndUtc),
    splitPlanHash: input.splitPlanHash,
    source: sandboxSourceNoteSchema.parse(input.source),
    oosResult: null,
    concludedAtUtc: null,
    createdAtUtc: utcInstantSchema.parse(input.createdAtUtc),
  };
  return sandboxExperimentSchema.parse({
    ...content,
    experimentId: sandboxExperimentIdFor(content),
  });
}

/**
 * Conclude a draft experiment with its OOS result (idempotent: the content
 * changes so a new id derives; a concluded experiment cannot re-conclude).
 */
export function concludeSandboxExperiment(
  experiment: SandboxExperiment,
  oosResult: SandboxOosResult,
  concludedAtUtc: string,
): SandboxExperiment {
  const e = sandboxExperimentSchema.parse(experiment);
  if (e.oosResult !== null) {
    throw new FeatureSandboxError("experiment is already concluded (immutable result)");
  }
  const content: SandboxExperimentContent = {
    ...e,
    oosResult: sandboxOosResultSchema.parse(oosResult),
    concludedAtUtc: utcInstantSchema.parse(concludedAtUtc),
  };
  return sandboxExperimentSchema.parse({
    ...content,
    experimentId: sandboxExperimentIdFor(content),
  });
}

/** Registry summary: all experiments, grouped by family (deterministic). */
export function summarizeSandbox(experiments: readonly SandboxExperiment[]): {
  total: number;
  drafts: number;
  concluded: number;
  beatBaseline: number;
  byFamily: Array<{ family: SandboxFamily; count: number }>;
} {
  const parsed = experiments.map((e) => sandboxExperimentSchema.parse(e));
  const families = [...SANDBOX_FAMILIES].map((f) => ({
    family: f,
    count: parsed.filter((e) => e.family === f).length,
  }));
  return {
    total: parsed.length,
    drafts: parsed.filter((e) => e.oosResult === null).length,
    concluded: parsed.filter((e) => e.oosResult !== null).length,
    beatBaseline: parsed.filter((e) => e.oosResult?.beatBaseline === true).length,
    byFamily: families,
  };
}
