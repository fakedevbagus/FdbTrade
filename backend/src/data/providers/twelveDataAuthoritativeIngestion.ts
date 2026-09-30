/**
 * R1.17 authoritative Twelve Data ingestion.
 *
 * One explicit call collects bounded, closed provider pages, proves complete
 * session-aware coverage and quality, then publishes through the unchanged
 * R0.6 content-addressed authority. Nothing in this module schedules work,
 * evaluates signals, runs research/paper workflows, or falls back to fixtures.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  TIMEFRAME_MS,
  getInstrument,
  getSchedule,
  historicalCandlesRequestSchema,
  isInstantInSchedule,
  licenseNoteSchema,
  type Candle,
  type DatasetManifest,
  type HistoricalCandlesRequest,
} from "@fdbtrade/contracts";

import { buildDatasetManifest } from "@/data/manifest";
import { candleRangeCacheKey } from "@/data/ingestion/cache";
import { jobIdFor } from "@/data/ingestion/jobs";
import {
  MarketDataAuthority,
  assertApprovedMarketScope,
  type StoredDataset,
} from "@/data/marketAuthority";
import { validateCandleSeries } from "@/data/quality/validator";
import {
  TwelveDataBudget,
  executeTwelveDataRead,
  type BoundaryResult,
  type TwelveDataPorts,
  type TwelveDataQuery,
} from "@/data/providers/twelveDataBoundary";
import {
  TwelveDataShadowError,
  normalizeTwelveDataShadowPayload,
} from "@/data/providers/twelveDataShadow";
import { withImmediateTransaction } from "@/db/sqlite.mjs";

export const TWELVE_DATA_AUTHORITY_PROVIDER_ID = "twelve-data";
export const TWELVE_DATA_AUTHORITY_MAX_PAGE_BARS = 1_000;
export const TWELVE_DATA_AUTHORITY_MAX_PAGES = 5;
export const TWELVE_DATA_AUTHORITY_MAX_BARS =
  TWELVE_DATA_AUTHORITY_MAX_PAGE_BARS * TWELVE_DATA_AUTHORITY_MAX_PAGES;

const INSTRUMENT_TO_PAIR = Object.freeze({
  EURUSD: "EUR/USD",
  GBPUSD: "GBP/USD",
  USDJPY: "USD/JPY",
  USDCHF: "USD/CHF",
  AUDUSD: "AUD/USD",
  USDCAD: "USD/CAD",
  NZDUSD: "NZD/USD",
} as const);

const TIMEFRAME_TO_INTERVAL = Object.freeze({
  "15m": "15min",
  "1h": "1h",
  "4h": "4h",
} as const);

type Row = Record<string, unknown>;

export interface TwelveDataPage {
  readonly startUtc: string;
  readonly endExclusiveUtc: string;
  readonly endInclusiveUtc: string;
  readonly bars: number;
}

export type AuthoritativeTwelveDataResult =
  | { readonly status: "succeeded"; readonly executed: boolean; readonly dataset: StoredDataset }
  | { readonly status: "failed"; readonly executed: boolean; readonly reason: string };

export interface AuthoritativeTwelveDataOptions {
  readonly configDir: string;
  readonly createdAtUtc: string;
  readonly assessedAtUtc: string;
  readonly license: DatasetManifest["license"];
  readonly ports: TwelveDataPorts;
  readonly budget: TwelveDataBudget;
  readonly expectedUid?: number | null;
  /** Test-only narrowing; production cannot exceed the fixed maximum. */
  readonly pageSizeBars?: number;
  readonly executeRead?: typeof executeTwelveDataRead;
  readonly faultAfterPublication?: () => void;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function exactUtc(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validateLicense(license: DatasetManifest["license"]): DatasetManifest["license"] {
  const parsed = licenseNoteSchema.parse(license);
  if (parsed.status !== "verified" || parsed.evidenceUrl === null) {
    throw new Error("Twelve Data authority requires verified license evidence");
  }
  const evidence = new URL(parsed.evidenceUrl);
  if (evidence.protocol !== "https:" ||
      !(evidence.hostname === "twelvedata.com" || evidence.hostname.endsWith(".twelvedata.com"))) {
    throw new Error("Twelve Data license evidence must use an official HTTPS origin");
  }
  return parsed;
}

export function planTwelveDataPages(
  requestInput: HistoricalCandlesRequest,
  pageSizeBars = TWELVE_DATA_AUTHORITY_MAX_PAGE_BARS,
): readonly TwelveDataPage[] {
  const request = historicalCandlesRequestSchema.parse(requestInput);
  assertApprovedMarketScope(request.instrument, request.timeframe);
  if (!Number.isSafeInteger(pageSizeBars) || pageSizeBars < 1 ||
      pageSizeBars > TWELVE_DATA_AUTHORITY_MAX_PAGE_BARS) {
    throw new Error("page size outside the bounded policy");
  }
  const frameMs = TIMEFRAME_MS[request.timeframe];
  const startMs = Date.parse(request.startUtc);
  const endMs = Date.parse(request.endUtc);
  if (startMs % frameMs !== 0 || endMs % frameMs !== 0 ||
      (endMs - startMs) % frameMs !== 0) {
    throw new Error("provider ingestion range must align to complete timeframe bars");
  }
  const totalBars = (endMs - startMs) / frameMs;
  if (totalBars < 1 || totalBars > TWELVE_DATA_AUTHORITY_MAX_BARS) {
    throw new Error("provider ingestion range exceeds the bounded bar limit");
  }
  const pages: TwelveDataPage[] = [];
  for (let offset = 0; offset < totalBars; offset += pageSizeBars) {
    const bars = Math.min(pageSizeBars, totalBars - offset);
    const pageStartMs = startMs + offset * frameMs;
    const pageEndExclusiveMs = pageStartMs + bars * frameMs;
    pages.push(Object.freeze({
      startUtc: new Date(pageStartMs).toISOString(),
      endExclusiveUtc: new Date(pageEndExclusiveMs).toISOString(),
      endInclusiveUtc: new Date(pageEndExclusiveMs - frameMs).toISOString(),
      bars,
    }));
  }
  if (pages.length > TWELVE_DATA_AUTHORITY_MAX_PAGES) {
    throw new Error("provider ingestion range exceeds the bounded page limit");
  }
  return Object.freeze(pages);
}

function expectedSessionOpens(request: HistoricalCandlesRequest): readonly string[] {
  const frameMs = TIMEFRAME_MS[request.timeframe];
  const schedule = getSchedule(getInstrument(request.instrument).sessionsRef);
  const expected: string[] = [];
  for (let cursor = Date.parse(request.startUtc); cursor < Date.parse(request.endUtc); cursor += frameMs) {
    const open = new Date(cursor).toISOString();
    const close = new Date(cursor + frameMs).toISOString();
    if (isInstantInSchedule(open, schedule) && isInstantInSchedule(close, schedule)) {
      expected.push(open);
    }
  }
  return Object.freeze(expected);
}

function stableFailure(error: unknown): string {
  if (error instanceof TwelveDataShadowError) return `provider_evidence_${error.code}`;
  return "provider_evidence_rejected";
}

export class AuthoritativeTwelveDataIngestion {
  constructor(
    private readonly database: DatabaseSync,
    private readonly authority: MarketDataAuthority,
  ) {}

  private fail(dedupKey: string, atUtc: string, reason: string): AuthoritativeTwelveDataResult {
    withImmediateTransaction(this.database, () => {
      this.database.prepare(`
        UPDATE market_data_ingestion_jobs
        SET status = 'failed', failure_reason = ?, updated_at_utc = ?
        WHERE dedup_key = ? AND status = 'running'
      `).run(reason, atUtc, dedupKey);
    });
    return { status: "failed", executed: true, reason };
  }

  async ingest(
    requestInput: HistoricalCandlesRequest,
    options: AuthoritativeTwelveDataOptions,
  ): Promise<AuthoritativeTwelveDataResult> {
    const request = historicalCandlesRequestSchema.parse(requestInput);
    assertApprovedMarketScope(request.instrument, request.timeframe);
    const license = validateLicense(options.license);
    if (!exactUtc(options.createdAtUtc) || !exactUtc(options.assessedAtUtc)) {
      throw new Error("createdAtUtc and assessedAtUtc must be exact UTC instants");
    }
    const frameMs = TIMEFRAME_MS[request.timeframe];
    const assessedMs = Date.parse(options.assessedAtUtc);
    if (assessedMs < Date.parse(request.endUtc)) {
      throw new Error("freshness assessment cannot precede the requested range end");
    }
    if (assessedMs - Date.parse(request.endUtc) > frameMs * 2) {
      throw new Error("stale provider ranges cannot become authority");
    }
    const pages = planTwelveDataPages(request, options.pageSizeBars);
    const dedupKey = candleRangeCacheKey(
      TWELVE_DATA_AUTHORITY_PROVIDER_ID,
      request.instrument,
      request.timeframe,
      request.startUtc,
      request.endUtc,
    );
    const expectedRequestHash = digest({
      providerId: TWELVE_DATA_AUTHORITY_PROVIDER_ID,
      request,
      license,
      pageSizeBars: options.pageSizeBars ?? TWELVE_DATA_AUTHORITY_MAX_PAGE_BARS,
    });
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
      `).run(
        jobIdFor(dedupKey), dedupKey, expectedRequestHash,
        options.createdAtUtc, options.createdAtUtc,
      );
    }
    withImmediateTransaction(this.database, () => {
      this.database.prepare(`
        UPDATE market_data_ingestion_jobs
        SET status = 'running', attempts = attempts + 1, updated_at_utc = ?
        WHERE dedup_key = ? AND status = 'pending'
      `).run(options.createdAtUtc, dedupKey);
    });

    const pair = INSTRUMENT_TO_PAIR[request.instrument as keyof typeof INSTRUMENT_TO_PAIR];
    const interval = TIMEFRAME_TO_INTERVAL[request.timeframe as keyof typeof TIMEFRAME_TO_INTERVAL];
    const executeRead = options.executeRead ?? executeTwelveDataRead;
    const collected: Candle[] = [];
    try {
      for (const page of pages) {
        const query: TwelveDataQuery = {
          pair,
          interval,
          outputsize: page.bars,
          startDateUtc: page.startUtc,
          endDateUtc: page.endInclusiveUtc,
        };
        const boundary: BoundaryResult = await executeRead({
          configDir: options.configDir,
          query,
          ports: options.ports,
          budget: options.budget,
          ...(options.expectedUid !== undefined ? { expectedUid: options.expectedUid } : {}),
        });
        if (!boundary.ok) {
          return this.fail(dedupKey, options.createdAtUtc, `provider_page_${boundary.code}`);
        }
        const normalized = normalizeTwelveDataShadowPayload({
          bodyText: boundary.bodyText,
          query,
          observedAtUtc: options.assessedAtUtc,
        });
        if (normalized.excludedOpenTimestamps.length > 0) {
          return this.fail(dedupKey, options.createdAtUtc, "provider_page_contains_open_bar");
        }
        const pageStartMs = Date.parse(page.startUtc);
        const pageEndMs = Date.parse(page.endExclusiveUtc);
        for (const candle of normalized.closedCandles) {
          const timestampMs = Date.parse(candle.timestamp);
          if (timestampMs < pageStartMs || timestampMs >= pageEndMs ||
              candle.instrument !== request.instrument || candle.timeframe !== request.timeframe) {
            return this.fail(dedupKey, options.createdAtUtc, "provider_page_scope_mismatch");
          }
          collected.push(candle as Candle);
        }
      }
    } catch (error) {
      return this.fail(dedupKey, options.createdAtUtc, stableFailure(error));
    }

    collected.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    const timestamps = collected.map((candle) => candle.timestamp);
    if (new Set(timestamps).size !== timestamps.length) {
      return this.fail(dedupKey, options.createdAtUtc, "provider_duplicate_timestamp");
    }
    const report = validateCandleSeries(collected);
    if (report.quarantined.length > 0) {
      return this.fail(dedupKey, options.createdAtUtc, "provider_quarantined_rows");
    }
    if (report.gaps.length > 0) {
      return this.fail(dedupKey, options.createdAtUtc, "provider_session_gap");
    }
    const expected = expectedSessionOpens(request);
    if (expected.length === 0 || collected.length === 0 ||
        expected.length !== timestamps.length ||
        expected.some((timestamp, index) => timestamp !== timestamps[index])) {
      return this.fail(dedupKey, options.createdAtUtc, "provider_incomplete_coverage");
    }
    const latestCloseMs = Date.parse(collected[collected.length - 1].timestamp) + frameMs;
    if (assessedMs - latestCloseMs > frameMs * 2) {
      return this.fail(dedupKey, options.createdAtUtc, "provider_evidence_stale");
    }

    const manifest = buildDatasetManifest(
      TWELVE_DATA_AUTHORITY_PROVIDER_ID,
      collected,
      license,
      { createdAtUtc: options.createdAtUtc },
    );
    const dataset = this.authority.publish(
      manifest,
      collected,
      {
        accepted: collected.length,
        quarantined: 0,
        gaps: 0,
        duplicates: 0,
        mode: "historical",
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