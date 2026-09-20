/**
 * Immutable dataset registry (M46).
 *
 * Stores registered dataset manifests with their canonical candle data.
 * Invariants:
 * - Registration is idempotent: same checksum = absorbed; different content
 *   under the same datasetId = fail closed.
 * - No mutation after registration (immutable once stored).
 * - Dataset list shows pair, timeframe, coverage, provenance, quality state.
 * - Filesystem-backed: one JSON per dataset under a caller-supplied directory.
 * - Deterministic — no clock inside (createdAtUtc is an explicit input).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import {
  type Candle,
  type DatasetManifest,
  datasetManifestSchema,
  serializeCandlesCanonical,
} from "@fdbtrade/contracts";

/** Quality state of a registered dataset. */
export const DATA_SOURCE_MODES = [
  "fixture",
  "historical",
  "shadow",
  "stale",
  "unavailable",
  "degraded",
] as const;
export type DataSourceMode = (typeof DATA_SOURCE_MODES)[number];

/** Quality summary attached to a registered dataset. */
export interface DatasetQualitySummary {
  accepted: number;
  quarantined: number;
  gaps: number;
  duplicates: number;
  mode: DataSourceMode;
}

/** Stored dataset entry: manifest + quality + candles. */
export interface StoredDataset {
  manifest: DatasetManifest;
  quality: DatasetQualitySummary;
  candles: readonly Candle[];
}

/** Dataset list entry (no candles, lightweight). */
export interface DatasetListEntry {
  datasetId: string;
  providerId: string;
  instrument: string;
  timeframe: string;
  periodStartUtc: string;
  periodEndUtc: string;
  recordCount: number;
  checksum: string;
  mode: DataSourceMode;
  quality: DatasetQualitySummary;
  createdAtUtc: string;
}

function datasetPath(directory: string, datasetId: string): string {
  // Sanitize datasetId for filesystem (replace pipe with underscore).
  const safe = datasetId.replace(/[|/\\:*?"<>]/g, "_");
  return path.join(directory, `${safe}.json`);
}

/**
 * Register a dataset. Idempotent: same digest = no-op return.
 * Different content under same datasetId = throws.
 */
export function registerDataset(
  directory: string,
  manifest: DatasetManifest,
  candles: readonly Candle[],
  quality: DatasetQualitySummary,
): StoredDataset {
  datasetManifestSchema.parse(manifest);

  // Verify candle content matches manifest checksum.
  const digest = createHash("sha256")
    .update(serializeCandlesCanonical(candles), "utf8")
    .digest("hex");
  if (digest !== manifest.checksum.digest) {
    throw new Error(
      `Dataset registration rejected: content checksum mismatch (expected ${manifest.checksum.digest}, computed ${digest})`,
    );
  }

  mkdirSync(directory, { recursive: true });
  const file = datasetPath(directory, manifest.datasetId);

  if (existsSync(file)) {
    const existing = JSON.parse(readFileSync(file, "utf8")) as StoredDataset;
    if (existing.manifest.checksum.digest === manifest.checksum.digest) {
      return existing; // Idempotent — same content.
    }
    throw new Error(
      `Dataset ${manifest.datasetId} already registered with different content (digest mismatch)`,
    );
  }

  const stored: StoredDataset = { manifest, quality, candles };
  writeFileSync(file, JSON.stringify(stored, null, 2) + "\n", "utf8");
  return stored;
}

/** Load a registered dataset by id. Returns null if not found. */
export function loadDataset(directory: string, datasetId: string): StoredDataset | null {
  const file = datasetPath(directory, datasetId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as StoredDataset;
  } catch {
    return null;
  }
}

/** List all registered datasets (lightweight — no candles). */
export function listDatasets(directory: string): DatasetListEntry[] {
  if (!existsSync(directory)) return [];
  const entries: DatasetListEntry[] = [];
  for (const filename of readdirSync(directory)) {
    if (!filename.endsWith(".json")) continue;
    try {
      const raw = readFileSync(path.join(directory, filename), "utf8");
      const stored = JSON.parse(raw) as StoredDataset;
      const m = stored.manifest;
      entries.push({
        datasetId: m.datasetId,
        providerId: m.providerId,
        instrument: m.instrument,
        timeframe: m.timeframe,
        periodStartUtc: m.periodStartUtc,
        periodEndUtc: m.periodEndUtc,
        recordCount: m.recordCount,
        checksum: m.checksum.digest,
        mode: stored.quality.mode,
        quality: stored.quality,
        createdAtUtc: m.createdAtUtc,
      });
    } catch {
      // Skip corrupt files.
    }
  }
  return entries.sort((a, b) => a.createdAtUtc.localeCompare(b.createdAtUtc));
}

/**
 * Verify a dataset's integrity: recompute checksum from stored candles
 * and compare against the manifest.
 */
export function verifyDataset(dataset: StoredDataset): { ok: boolean; reason?: string } {
  const digest = createHash("sha256")
    .update(serializeCandlesCanonical(dataset.candles), "utf8")
    .digest("hex");
  if (digest !== dataset.manifest.checksum.digest) {
    return { ok: false, reason: `checksum mismatch: stored ${dataset.manifest.checksum.digest}, computed ${digest}` };
  }
  if (dataset.candles.length !== dataset.manifest.recordCount) {
    return { ok: false, reason: `record count mismatch: manifest ${dataset.manifest.recordCount}, candles ${dataset.candles.length}` };
  }
  return { ok: true };
}
