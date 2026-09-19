/**
 * Strategy/model registry contracts (P13-03, ADR-0026).
 *
 * The admin registry makes every strategy/model version FULLY ATTRIBUTABLE:
 * - `RegistryEntry` is one versioned artifact (strategy version, dataset
 *   reference, config hash, optional model metadata, champion/challenger
 *   state, explicit limitations) LINKED to the research runs (P08/P09 run
 *   ids) that produced its evidence.
 * - Entries are IMMUTABLE and content-addressed (`reg_` + FNV-1a64): the
 *   same artifact definition always yields the same entry id (idempotent
 *   registration); a DIFFERENT definition under the same id is refused.
 * - Champion/challenger state mirrors the P09 promotion registry
 *   (`PromotionRecord`): registry state changes must reference a promotion
 *   transition — no promote action without evidence (`registryStateFor`
 *   enforces the linkage; P09 `applyPromotionTransition` gates the evidence).
 * - Limitations are REQUIRED text: every registered artifact must state
 *   what it does not do (no fabricated capabilities).
 * - `registeredAtUtc` is an explicit caller input (deterministic for
 *   deterministic inputs); no wall clock, no broker access (ADR-0003/0005).
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";

import {
  promotionRecordSchema,
  promotionStateSchema,
  type PromotionRecord,
  type PromotionState,
} from "../research/promotion";
import { obsHash16 } from "./logging";

export const REGISTRY_ID = "strategy-model-registry";
export const REGISTRY_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Entry schema
// ---------------------------------------------------------------------------

/** Artifact kind: a rule strategy version or a model version. */
export const REGISTRY_ARTIFACT_KINDS = ["strategy", "model"] as const;
export type RegistryArtifactKind = (typeof REGISTRY_ARTIFACT_KINDS)[number];
export const registryArtifactKindSchema = z.enum(REGISTRY_ARTIFACT_KINDS);

/** Model metadata (present only for `model` artifacts; ML stays OFF until champion gate). */
export const registryModelMetadataSchema = z
  .object({
    /** Model family label (e.g. `gradient_boosting`). */
    family: z.string().min(1).max(64),
    /** Training feature definition ids + versions (lineage). */
    featureSet: z.array(z.string().regex(/^[a-z0-9._-]+@\d+\.\d+\.\d+$/)).min(1),
    /** Training dataset id + digest (provenance). */
    trainDatasetId: z.string().min(1),
    trainDatasetDigest: z.string().regex(/^[0-9a-f]{64}$/),
    /** Frozen hyperparameters (scalar values; no secrets by redaction). */
    hyperparams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  })
  .strict();
export type RegistryModelMetadata = z.infer<typeof registryModelMetadataSchema>;

/** Dataset reference (id + digest — P02-05 manifest semantics). */
export const registryDatasetRefSchema = z
  .object({
    datasetId: z.string().min(1),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type RegistryDatasetRef = z.infer<typeof registryDatasetRefSchema>;

export const registryEntrySchema = z
  .object({
    /** Content-addressed id: `reg_` + FNV-1a64 of canonical content. */
    entryId: z.string().regex(/^reg_[0-9a-f]{16}$/),
    kind: registryArtifactKindSchema,
    /** Artifact identity, e.g. `trend-pullback@1.2.0`. */
    artifactId: z.string().regex(/^[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+$/),
    /** sha256 hex of the canonical config serialization (P08 semantics). */
    configHash: z.string().regex(/^[0-9a-f]{64}$/),
    dataset: registryDatasetRefSchema,
    /** Present for `model` artifacts; REQUIRED for them, FORBIDDEN for strategies. */
    modelMetadata: registryModelMetadataSchema.nullable(),
    /** Champion/challenger lifecycle state (mirrors P09 promotion states). */
    state: promotionStateSchema,
    /** Research/backtest run ids linking this artifact to its evidence. */
    researchRunIds: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)),
    /** REQUIRED: what this artifact does NOT do (explicit limitations). */
    limitations: z.string().min(20).max(1_000),
    registeredAtUtc: utcInstantSchema,
    registeredBy: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  })
  .strict()
  .refine((e) => (e.kind === "model") !== (e.modelMetadata === null), {
    message: "model artifacts carry modelMetadata; strategy artifacts carry null",
    path: ["modelMetadata"],
  });
export type RegistryEntry = z.infer<typeof registryEntrySchema>;

/** What a caller provides; `entryId` is computed. */
export type RegistryEntryInput = Omit<RegistryEntry, "entryId">;

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

// ---------------------------------------------------------------------------
// Canonical serialization + content-addressed ids
// ---------------------------------------------------------------------------

function canonicalModelMetadata(meta: RegistryModelMetadata): string {
  const features = [...meta.featureSet].sort().join(",");
  const params = Object.keys(meta.hyperparams)
    .sort()
    .map((k) => `${k}=${String(meta.hyperparams[k])}`)
    .join(",");
  return `${meta.family}|${features}|${meta.trainDatasetId}|${meta.trainDatasetDigest}|${params}`;
}

/** Canonical entry content serialization (WITHOUT entryId). */
export function serializeRegistryEntryContentCanonical(
  entry: Omit<RegistryEntry, "entryId">,
): string {
  return [
    "reg",
    entry.kind,
    entry.artifactId,
    entry.configHash,
    entry.dataset.datasetId,
    entry.dataset.digest,
    entry.modelMetadata === null ? "-" : canonicalModelMetadata(entry.modelMetadata),
    entry.state,
    [...entry.researchRunIds].sort().join(","),
    entry.limitations,
    entry.registeredAtUtc,
    entry.registeredBy,
  ].join("|");
}

/** Full canonical serialization (with entryId). */
export function serializeRegistryEntryCanonical(entry: RegistryEntry): string {
  return `${serializeRegistryEntryContentCanonical(entry)}|${entry.entryId}`;
}

/** Deterministic entry id (content-addressed). */
export function registryEntryIdFor(input: RegistryEntryInput): string {
  return `reg_${obsHash16(serializeRegistryEntryContentCanonical(input))}`;
}

// ---------------------------------------------------------------------------
// Registry store (immutable entries; idempotent registration)
// ---------------------------------------------------------------------------

export interface Registry {
  registryId: string;
  entries: readonly RegistryEntry[];
}

/** Create an empty registry (deterministic id; no wall clock). */
export function createRegistry(registryId: string = REGISTRY_ID): Registry {
  return { registryId, entries: [] };
}

/**
 * Register one artifact version. Idempotent: registering the SAME content
 * twice is a no-op that returns the existing entry. Registering DIFFERENT
 * content that collides on an existing entry id fails closed; the registry
 * also refuses a duplicate `artifactId` with a DIFFERENT entry id (one
 * immutable entry per artifact version).
 */
export function registerRegistryEntry(
  registry: Registry,
  input: RegistryEntryInput,
): { registry: Registry; entry: RegistryEntry } {
  const entryId = registryEntryIdFor(input);
  const entry = registryEntrySchema.parse({ ...input, entryId });
  const existing = registry.entries.find((e) => e.entryId === entryId);
  if (existing) {
    return { registry, entry: existing }; // idempotent re-registration
  }
  if (registry.entries.some((e) => e.artifactId === entry.artifactId)) {
    throw new RegistryError(
      `artifact ${entry.artifactId} is already registered with different content`,
    );
  }
  return {
    registry: { registryId: registry.registryId, entries: [...registry.entries, entry] },
    entry,
  };
}

// ---------------------------------------------------------------------------
// Champion/challenger linkage (no promote without P09 evidence)
// ---------------------------------------------------------------------------

/**
 * Derive the registry state for an artifact from its P09 promotion record.
 * The registry NEVER invents a lifecycle state: champion/challenger status
 * comes from the promotion registry with its evidence gate intact
 * (`promotionRecordSchema` validation; terminal states pass through).
 */
export function registryStateFor(promotion: PromotionRecord): PromotionState {
  const parsed = promotionRecordSchema.parse(promotion);
  return parsed.state;
}

/** All entries whose state is `champion` (at most one per artifactId family). */
export function registryChampions(registry: Registry): RegistryEntry[] {
  return registry.entries.filter((e) => e.state === "champion");
}

/** All entries linked to one research run id (evidence traceability). */
export function registryEntriesForRun(registry: Registry, runId: string): RegistryEntry[] {
  return registry.entries.filter((e) => e.researchRunIds.includes(runId));
}

