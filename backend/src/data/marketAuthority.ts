/** R0.6 SQLite metadata plus content-addressed market-data artifact authority. */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  candleSchema,
  datasetManifestSchema,
  serializeCandlesCanonical,
  TIMEFRAME_MS,
  type Candle,
  type DatasetManifest,
} from "@fdbtrade/contracts";

import { withImmediateTransaction } from "../db/sqlite.mjs";

export const APPROVED_MARKET_INSTRUMENTS = [
  "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD",
] as const;
export const APPROVED_MARKET_TIMEFRAMES = ["15m", "1h", "4h"] as const;

export type MarketSourceMode = "fixture" | "historical";
export type MarketQualityState = "accepted" | "quarantined" | "gapped";
export type MarketFreshnessState = "fresh" | "stale";

export interface DatasetQualitySummary {
  accepted: number;
  quarantined: number;
  gaps: number;
  duplicates: number;
  mode: MarketSourceMode;
}

export interface StoredDataset {
  manifest: DatasetManifest;
  quality: DatasetQualitySummary;
  qualityState: MarketQualityState;
  freshnessState: MarketFreshnessState;
  latestBarCloseUtc: string;
  assessedAtUtc: string;
  candles: readonly Candle[];
}

export interface DatasetListEntry {
  datasetId: string;
  providerId: string;
  instrument: string;
  timeframe: string;
  periodStartUtc: string;
  periodEndUtc: string;
  recordCount: number;
  checksum: string;
  mode: MarketSourceMode;
  quality: DatasetQualitySummary;
  qualityState: MarketQualityState;
  freshnessState: MarketFreshnessState;
  latestBarCloseUtc: string;
  assessedAtUtc: string;
  createdAtUtc: string;
}

type Row = Record<string, unknown>;
type PublicationStage = "after_artifact_rename" | "after_metadata_commit";

export interface PublicationOptions {
  assessedAtUtc: string;
  fault?: (stage: PublicationStage) => void;
}

export interface RecoveryReport {
  removedStagingFiles: number;
  orphanArtifacts: number;
  verifiedDatasets: number;
  corruptDatasets: string[];
  recoveredJobs: number;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function assertApprovedMarketScope(instrument: string, timeframe: string): void {
  if (!(APPROVED_MARKET_INSTRUMENTS as readonly string[]).includes(instrument)) {
    throw new Error(`instrument outside R0.6 authority: ${instrument}`);
  }
  if (!(APPROVED_MARKET_TIMEFRAMES as readonly string[]).includes(timeframe)) {
    throw new Error(`timeframe outside R0.6 authority: ${timeframe}`);
  }
}

function ensureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("market-data artifact root must be a real directory");
  }
  chmodSync(directory, 0o700);
}

function syncDirectory(directory: string): void {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function parseCanonicalCandles(content: string): Candle[] {
  if (!content) return [];
  return content.split("\n").map((line) => {
    const fields = line.split("|");
    if (fields.length !== 8) throw new Error("invalid canonical candle artifact");
    const [instrument, timeframe, timestamp, open, high, low, close, volume] = fields;
    return candleSchema.parse({
      instrument,
      timeframe,
      timestamp,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: volume === "-" ? null : Number(volume),
    });
  });
}

function qualityState(quality: DatasetQualitySummary): MarketQualityState {
  if (quality.quarantined > 0 || quality.duplicates > 0) return "quarantined";
  if (quality.gaps > 0) return "gapped";
  return "accepted";
}

function freshness(
  manifest: DatasetManifest,
  assessedAtUtc: string,
): { state: MarketFreshnessState; latestBarCloseUtc: string } {
  const assessedMs = Date.parse(assessedAtUtc);
  if (!Number.isFinite(assessedMs)) throw new Error("assessedAtUtc must be a UTC instant");
  const latestBarCloseUtc = manifest.periodEndUtc;
  if (assessedMs < Date.parse(latestBarCloseUtc)) {
    throw new Error("freshness assessment cannot precede the latest completed bar");
  }
  const maxAgeMs = TIMEFRAME_MS[manifest.timeframe] * 2;
  return {
    state: assessedMs - Date.parse(latestBarCloseUtc) <= maxAgeMs ? "fresh" : "stale",
    latestBarCloseUtc,
  };
}

function artifactRelativePath(digest: string): string {
  return path.join("sha256", digest.slice(0, 2), `${digest}.candles`);
}

function rowToListEntry(row: Row): DatasetListEntry {
  return {
    datasetId: String(row.dataset_id),
    providerId: String(row.provider_id),
    instrument: String(row.instrument),
    timeframe: String(row.timeframe),
    periodStartUtc: String(row.period_start_utc),
    periodEndUtc: String(row.period_end_utc),
    recordCount: Number(row.record_count),
    checksum: String(row.artifact_digest),
    mode: String(row.source_mode) as MarketSourceMode,
    quality: JSON.parse(String(row.quality_json)) as DatasetQualitySummary,
    qualityState: String(row.quality_state) as MarketQualityState,
    freshnessState: String(row.freshness_state) as MarketFreshnessState,
    latestBarCloseUtc: String(row.latest_bar_close_utc),
    assessedAtUtc: String(row.assessed_at_utc),
    createdAtUtc: String(row.created_at_utc),
  };
}

export class MarketDataAuthority {
  readonly stagingRoot: string;

  constructor(
    private readonly database: DatabaseSync,
    readonly artifactRoot: string,
  ) {
    this.stagingRoot = path.join(artifactRoot, ".staging");
  }

  private row(datasetId: string): Row | undefined {
    return this.database.prepare(`
      SELECT d.*, a.relative_path, a.byte_count
      FROM market_data_datasets AS d
      JOIN market_data_artifacts AS a ON a.digest = d.artifact_digest
      WHERE d.dataset_id = ?
    `).get(datasetId) as Row | undefined;
  }

  private readStored(row: Row): StoredDataset {
    const manifest = datasetManifestSchema.parse(JSON.parse(String(row.manifest_json)));
    const file = path.join(this.artifactRoot, String(row.relative_path));
    const content = readFileSync(file, "utf8");
    const digest = sha256(content);
    if (digest !== String(row.artifact_digest) || Buffer.byteLength(content) !== Number(row.byte_count)) {
      throw new Error(`artifact integrity failure for dataset ${manifest.datasetId}`);
    }
    const candles = parseCanonicalCandles(content);
    if (candles.length !== manifest.recordCount) {
      throw new Error(`artifact record count failure for dataset ${manifest.datasetId}`);
    }
    return {
      manifest,
      quality: JSON.parse(String(row.quality_json)) as DatasetQualitySummary,
      qualityState: String(row.quality_state) as MarketQualityState,
      freshnessState: String(row.freshness_state) as MarketFreshnessState,
      latestBarCloseUtc: String(row.latest_bar_close_utc),
      assessedAtUtc: String(row.assessed_at_utc),
      candles,
    };
  }

  publish(
    manifestInput: DatasetManifest,
    candles: readonly Candle[],
    quality: DatasetQualitySummary,
    options: PublicationOptions,
  ): StoredDataset {
    const manifest = datasetManifestSchema.parse(manifestInput);
    assertApprovedMarketScope(manifest.instrument, manifest.timeframe);
    if (quality.mode !== "fixture" && quality.mode !== "historical") {
      throw new Error(`unsupported market-data source mode: ${quality.mode}`);
    }
    if (quality.accepted !== candles.length || candles.length !== manifest.recordCount) {
      throw new Error("quality accepted count must equal immutable artifact record count");
    }
    const content = serializeCandlesCanonical(candles);
    const digest = sha256(content);
    if (digest !== manifest.checksum.digest) {
      throw new Error(`Dataset registration rejected: content checksum mismatch (expected ${manifest.checksum.digest}, computed ${digest})`);
    }
    const existing = this.row(manifest.datasetId);
    if (existing) {
      if (String(existing.artifact_digest) !== digest) {
        throw new Error(`Dataset ${manifest.datasetId} already registered with different content (digest mismatch)`);
      }
      return this.readStored(existing);
    }

    ensureDirectory(this.artifactRoot);
    ensureDirectory(this.stagingRoot);
    const relative = artifactRelativePath(digest);
    const finalPath = path.join(this.artifactRoot, relative);
    const finalDirectory = path.dirname(finalPath);
    ensureDirectory(finalDirectory);
    if (existsSync(finalPath)) {
      const onDisk = readFileSync(finalPath, "utf8");
      if (sha256(onDisk) !== digest || onDisk !== content) {
        throw new Error(`content-addressed artifact collision for ${digest}`);
      }
    } else {
      const temporary = path.join(this.stagingRoot, `${digest}.${randomUUID()}.tmp`);
      const descriptor = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(descriptor, content, "utf8");
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporary, finalPath);
      chmodSync(finalPath, 0o600);
      syncDirectory(finalDirectory);
      options.fault?.("after_artifact_rename");
    }

    const measuredFreshness = freshness(manifest, options.assessedAtUtc);
    withImmediateTransaction(this.database, () => {
      this.database.prepare(`
        INSERT INTO market_data_artifacts (
          digest, relative_path, byte_count, media_type, created_at_utc
        ) VALUES (?, ?, ?, 'application/vnd.fdbtrade.candles', ?)
        ON CONFLICT(digest) DO NOTHING
      `).run(digest, relative, Buffer.byteLength(content), manifest.createdAtUtc);
      this.database.prepare(`
        INSERT INTO market_data_datasets (
          dataset_id, artifact_digest, provider_id, instrument, timeframe,
          source_mode, period_start_utc, period_end_utc, record_count,
          manifest_json, quality_json, accepted_count, quarantined_count,
          gap_count, duplicate_count, quality_state, freshness_state,
          latest_bar_close_utc, assessed_at_utc, created_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        manifest.datasetId, digest, manifest.providerId, manifest.instrument,
        manifest.timeframe, quality.mode, manifest.periodStartUtc,
        manifest.periodEndUtc, manifest.recordCount, JSON.stringify(manifest),
        JSON.stringify(quality), quality.accepted, quality.quarantined,
        quality.gaps, quality.duplicates, qualityState(quality),
        measuredFreshness.state, measuredFreshness.latestBarCloseUtc,
        options.assessedAtUtc, manifest.createdAtUtc,
      );
    });
    options.fault?.("after_metadata_commit");
    return this.load(manifest.datasetId) as StoredDataset;
  }

  load(datasetId: string): StoredDataset | null {
    const row = this.row(datasetId);
    return row ? this.readStored(row) : null;
  }

  list(): DatasetListEntry[] {
    return this.database.prepare(`
      SELECT * FROM market_data_datasets ORDER BY created_at_utc, dataset_id
    `).all().map((row) => rowToListEntry(row as Row));
  }

  recover(): RecoveryReport {
    ensureDirectory(this.artifactRoot);
    ensureDirectory(this.stagingRoot);
    let removedStagingFiles = 0;
    for (const name of readdirSync(this.stagingRoot)) {
      const candidate = path.join(this.stagingRoot, name);
      if (lstatSync(candidate).isFile()) {
        rmSync(candidate);
        removedStagingFiles += 1;
      }
    }
    const referenced = new Set(
      this.database.prepare("SELECT relative_path FROM market_data_artifacts").all()
        .map((row) => String((row as Row).relative_path)),
    );
    let orphanArtifacts = 0;
    const shaRoot = path.join(this.artifactRoot, "sha256");
    if (existsSync(shaRoot)) {
      for (const prefix of readdirSync(shaRoot)) {
        const prefixRoot = path.join(shaRoot, prefix);
        if (!lstatSync(prefixRoot).isDirectory()) continue;
        for (const name of readdirSync(prefixRoot)) {
          const relative = path.join("sha256", prefix, name);
          if (!referenced.has(relative)) orphanArtifacts += 1;
        }
      }
    }
    const corruptDatasets: string[] = [];
    let verifiedDatasets = 0;
    for (const entry of this.list()) {
      try {
        this.load(entry.datasetId);
        verifiedDatasets += 1;
      } catch {
        corruptDatasets.push(entry.datasetId);
      }
    }
    const recoveredJobs = withImmediateTransaction(this.database, () =>
      this.database.prepare(`
        UPDATE market_data_ingestion_jobs
        SET status = 'pending', updated_at_utc = created_at_utc
        WHERE status = 'running'
      `).run().changes,
    );
    return { removedStagingFiles, orphanArtifacts, verifiedDatasets, corruptDatasets, recoveredJobs };
  }
}
