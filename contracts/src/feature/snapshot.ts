/**
 * Feature snapshot contracts (P03-04).
 *
 * A feature snapshot is an IMMUTABLE, hash-addressed record of every feature
 * value produced for one (instrument, timeframe, event time, feature-group
 * version, data snapshot id). Persistence is append-only: the same input
 * snapshot + feature version always yields the SAME snapshot hash
 * (acceptance criterion), and historical lineage is never mutated.
 */
import { z } from "zod";

import { instrumentIdSchema } from "../marketdata/instrument";
import { timeframeSchema, utcInstantSchema } from "../marketdata/time";
import { featureVersionSchema } from "./definition";

/** Feature values: featureId -> number|boolean|null (null = warmup). */
export const featureValuesSchema = z.record(
  z.string().min(1),
  z.union([z.number(), z.boolean(), z.null()]),
);

export type FeatureValues = z.infer<typeof featureValuesSchema>;

/**
 * Dataset snapshot identity: which P02-05 dataset the feature values were
 * computed from (id + manifest checksum digest).
 */
export const dataSnapshotIdSchema = z
  .object({
    datasetId: z.string().min(1).max(128),
    /** sha256 digest (lowercase hex) of the manifest's canonical payload. */
    checksumDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type DataSnapshotId = z.infer<typeof dataSnapshotIdSchema>;

/** Store key: (instrument, timeframe, eventTime, group version, dataset). */
export const snapshotKeySchema = z
  .object({
    instrument: instrumentIdSchema,
    timeframe: timeframeSchema,
    eventTimeUtc: utcInstantSchema,
    featureGroupId: z.string().min(1),
    featureGroupVersion: featureVersionSchema,
    datasetId: z.string().min(1).max(128),
  })
  .strict();

export type SnapshotKey = z.infer<typeof snapshotKeySchema>;

/** The immutable stored feature snapshot record. */
export const featureSnapshotSchema = z
  .object({
    instrument: instrumentIdSchema,
    timeframe: timeframeSchema,
    /** UTC instant of the bar event the values are anchored to (open time). */
    eventTimeUtc: utcInstantSchema,
    featureGroupId: z.string().min(1),
    featureGroupVersion: featureVersionSchema,
    /** Data snapshot lineage (dataset id + manifest digest). */
    dataSnapshot: dataSnapshotIdSchema,
    /** Feature values keyed by featureId (null during warmup). */
    values: featureValuesSchema,
    /** Version of each feature definition used (featureId -> semver). */
    featureVersions: z.record(z.string().min(1), featureVersionSchema),
    /** sha256 of the canonical snapshot serialization (computed by builder). */
    snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
    /** Snapshot contract format version. */
    snapshotVersion: z.literal(1),
    /** UTC instant the snapshot was persisted (metadata only). */
    createdAtUtc: utcInstantSchema,
  })
  .strict()
  .refine(
    (s) => Object.keys(s.values).length > 0,
    { message: "values must contain at least one feature", path: ["values"] },
  )
  .refine(
    (s) => Object.keys(s.featureVersions).every((id) => id in s.values),
    {
      message: "featureVersions keys must all appear in values",
      path: ["featureVersions"],
    },
  );

export type FeatureSnapshot = z.infer<typeof featureSnapshotSchema>;

/**
 * Canonical snapshot serialization for hashing: stable field order, keys
 * sorted, nulls as `-`, numbers via JS `String()`. Byte-identical across
 * runs and with the Python mirror (which reimplements `String(number)` as
 * `js_number_str`, P02-05). Changing this form is a breaking change (pinned
 * by contract tests).
 */
export function serializeSnapshotCanonical(snapshot: Omit<FeatureSnapshot, "snapshotHash">): string {
  const valueStr = (v: number | boolean | null): string =>
    v === null ? "-" : typeof v === "boolean" ? (v ? "true" : "false") : String(v);
  const features = Object.keys(snapshot.values)
    .sort()
    .map((id) => `${id}=${valueStr(snapshot.values[id])}`)
    .join(";");
  const versions = Object.keys(snapshot.featureVersions)
    .sort()
    .map((id) => `${id}@${snapshot.featureVersions[id]}`)
    .join(";");
  return [
    "featuresnap",
    snapshot.instrument,
    snapshot.timeframe,
    snapshot.eventTimeUtc,
    snapshot.featureGroupId,
    snapshot.featureGroupVersion,
    snapshot.dataSnapshot.datasetId,
    snapshot.dataSnapshot.checksumDigest,
    features,
    versions,
    String(snapshot.snapshotVersion),
  ].join("|");
}

/**
 * Deterministic store key string: the natural identity of a snapshot.
 * Same key = same logical snapshot (idempotent persistence).
 */
export function snapshotKeyString(key: SnapshotKey): string {
  return [
    "featuresnap",
    key.instrument,
    key.timeframe,
    key.eventTimeUtc,
    key.featureGroupId,
    key.featureGroupVersion,
    key.datasetId,
  ].join("|");
}


