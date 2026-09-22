/** Durable R0.6 fixture ingestion into the market-data authority. */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { HistoricalCandlesRequest, MarketDataProvider } from "@fdbtrade/contracts";

import { buildDatasetManifest } from "@/data/manifest";
import { candleRangeCacheKey } from "@/data/ingestion/cache";
import { IngestionWorker, type SleepFn } from "@/data/ingestion/worker";
import { jobIdFor, type JobClock } from "@/data/ingestion/jobs";
import {
  MarketDataAuthority,
  assertApprovedMarketScope,
  type StoredDataset,
} from "@/data/marketAuthority";
import { withImmediateTransaction } from "@/db/sqlite.mjs";

type Row = Record<string, unknown>;

export type AuthoritativeIngestionResult =
  | { status: "succeeded"; executed: boolean; dataset: StoredDataset }
  | { status: "failed"; executed: boolean; reason: string };

export interface AuthoritativeIngestionOptions {
  createdAtUtc: string;
  assessedAtUtc: string;
  clock?: JobClock;
  sleep?: SleepFn;
  faultAfterPublication?: () => void;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requestHash(providerId: string, request: HistoricalCandlesRequest): string {
  return hash(JSON.stringify({ providerId, ...request }));
}

export class AuthoritativeFixtureIngestion {
  constructor(
    private readonly database: DatabaseSync,
    private readonly authority: MarketDataAuthority,
    private readonly provider: MarketDataProvider,
  ) {
    if (!provider.capabilities().isSynthetic) {
      throw new Error("R0.6 fixture ingestion accepts synthetic providers only");
    }
  }

  async ingest(
    request: HistoricalCandlesRequest,
    options: AuthoritativeIngestionOptions,
  ): Promise<AuthoritativeIngestionResult> {
    assertApprovedMarketScope(request.instrument, request.timeframe);
    if (Date.parse(options.assessedAtUtc) < Date.parse(request.endUtc)) {
      throw new Error("freshness assessment cannot precede the requested range end");
    }
    const dedupKey = candleRangeCacheKey(
      this.provider.id,
      request.instrument,
      request.timeframe,
      request.startUtc,
      request.endUtc,
    );
    const id = jobIdFor(dedupKey);
    const expectedRequestHash = requestHash(this.provider.id, request);
    const existing = this.database.prepare(`
      SELECT * FROM market_data_ingestion_jobs WHERE dedup_key = ?
    `).get(dedupKey) as Row | undefined;
    if (existing) {
      if (String(existing.request_hash) !== expectedRequestHash) {
        throw new Error("ingestion dedupe key request hash mismatch");
      }
      if (String(existing.status) === "succeeded") {
        const dataset = this.authority.load(String(existing.dataset_id));
        if (!dataset) throw new Error("succeeded ingestion job references missing dataset");
        return { status: "succeeded", executed: false, dataset };
      }
      if (String(existing.status) === "failed") {
        return { status: "failed", executed: false, reason: String(existing.failure_reason) };
      }
      if (String(existing.status) === "running") {
        return { status: "failed", executed: false, reason: "ingestion job requires recovery" };
      }
    } else {
      this.database.prepare(`
        INSERT INTO market_data_ingestion_jobs (
          job_id, dedup_key, request_hash, status, attempts,
          dataset_id, failure_reason, created_at_utc, updated_at_utc
        ) VALUES (?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)
      `).run(id, dedupKey, expectedRequestHash, options.createdAtUtc, options.createdAtUtc);
    }

    withImmediateTransaction(this.database, () => {
      this.database.prepare(`
        UPDATE market_data_ingestion_jobs
        SET status = 'running', attempts = attempts + 1, updated_at_utc = ?
        WHERE dedup_key = ? AND status = 'pending'
      `).run(options.createdAtUtc, dedupKey);
    });

    const worker = new IngestionWorker(this.provider, {
      clock: options.clock,
      sleep: options.sleep ?? (async () => {}),
    });
    const outcome = await worker.ingestCandles(request);
    if (outcome.job.status !== "succeeded") {
      const reason = outcome.job.failureReason ?? "fixture ingestion failed";
      withImmediateTransaction(this.database, () => {
        this.database.prepare(`
          UPDATE market_data_ingestion_jobs
          SET status = 'failed', failure_reason = ?, updated_at_utc = ?
          WHERE dedup_key = ? AND status = 'running'
        `).run(reason, options.createdAtUtc, dedupKey);
      });
      return { status: "failed", executed: true, reason };
    }

    const manifest = buildDatasetManifest(
      this.provider.id,
      outcome.candles,
      {
        status: "synthetic",
        source: "deterministic local fixture provider",
        evidenceUrl: null,
        note: "No credentialed or network provider was used.",
      },
      { createdAtUtc: options.createdAtUtc },
    );
    const dataset = this.authority.publish(
      manifest,
      outcome.candles,
      {
        accepted: outcome.candles.length,
        quarantined: outcome.quarantined.length,
        gaps: outcome.gaps.length,
        duplicates: outcome.quarantined.filter((row) => row.reason === "DUPLICATE_TIMESTAMP").length,
        mode: "fixture",
      },
      { assessedAtUtc: options.assessedAtUtc },
    );
    options.faultAfterPublication?.();
    withImmediateTransaction(this.database, () => {
      this.database.prepare(`
        UPDATE market_data_ingestion_jobs
        SET status = 'succeeded', dataset_id = ?, updated_at_utc = ?
        WHERE dedup_key = ? AND status = 'running'
      `).run(dataset.manifest.datasetId, options.createdAtUtc, dedupKey);
    });
    return { status: "succeeded", executed: true, dataset };
  }
}
