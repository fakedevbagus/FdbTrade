/**
 * Historical dataset import service (M46).
 *
 * Orchestrates: CSV parse → timestamp normalization → canonical candle
 * construction → quality validation → manifest build → preview report.
 * Deterministic — all time inputs are explicit; no wall clock.
 *
 * Import is a two-step process:
 * 1. `previewImport()` — parse, validate, produce quality report (no persist).
 * 2. `confirmImport()` — register into the immutable dataset registry.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export const historicalImportRequestSchema = z.object({
  csvText: z.string().min(1).max(10 * 1024 * 1024),
  instrument: z.string().min(1).max(32),
  timeframe: z.enum(TIMEFRAMES),
  providerId: z.string().min(1).max(128),
  license: z.object({
    status: z.enum(["verified", "unverified", "synthetic"]),
    source: z.string().min(1), evidenceUrl: z.string().url().nullable(), note: z.string(),
  }).strict(),
  createdAtUtc: z.string().datetime({ offset: true }),
}).strict();

export const historicalConfirmRequestSchema = historicalImportRequestSchema;

export type HistoricalImportRequestInput = z.infer<typeof historicalImportRequestSchema>;


import {
  type Candle,
  type DatasetManifest,
  type LicenseNote,
  type Timeframe,
  TIMEFRAME_MS,
  candleSchema,
  datasetIdFor,
  datasetManifestSchema,
  isKnownInstrument,
  getInstrument,
  serializeCandlesCanonical,
  TIMEFRAMES,
} from "@fdbtrade/contracts";

import { parseCsv, type CsvParseResult, type CsvParseError, MAX_IMPORT_ROWS } from "./csvParser";
import { validateCandleSeries, type CandleSeriesReport } from "@/data/quality/validator";
import {
  registerDataset,
  type DatasetQualitySummary,
  type StoredDataset,
} from "./datasetRegistry";

/** Import request parameters (explicit — no inference). */
export interface ImportRequest {
  csvText: string;
  instrument: string;
  timeframe: Timeframe;
  providerId: string;
  license: LicenseNote;
  createdAtUtc: string;
}

/** Preview report returned before confirmation. */
export interface ImportPreview {
  candles: readonly Candle[];
  manifest: DatasetManifest;
  parseErrors: CsvParseError[];
  quality: CandleSeriesReport;
  summary: ImportSummary;
}

export interface ImportSummary {
  totalCsvLines: number;
  csvParseErrors: number;
  accepted: number;
  quarantined: number;
  gaps: number;
  truncated: boolean;
  periodStartUtc: string | null;
  periodEndUtc: string | null;
  instrument: string;
  timeframe: string;
}

function normalizeTimestamp(raw: string): string {
  let ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    const num = Number(raw);
    if (Number.isFinite(num)) {
      ms = Math.abs(num) >= 1e11 ? num : num * 1000;
    } else {
      throw new Error(`Cannot parse timestamp: ${raw}`);
    }
  }
  return new Date(ms).toISOString();
}

export function previewImport(request: ImportRequest): ImportPreview {
  if (!isKnownInstrument(request.instrument)) {
    throw new Error(`Unknown instrument: ${request.instrument}`);
  }
  if (!(TIMEFRAMES as readonly string[]).includes(request.timeframe)) {
    throw new Error(`Unknown timeframe: ${request.timeframe}`);
  }

  const csvResult: CsvParseResult = parseCsv(request.csvText);
  const rawCandles: Candle[] = [];
  const parseErrors = [...csvResult.errors];

  for (const row of csvResult.rows) {
    try {
      const timestamp = normalizeTimestamp(row.timestamp);
      const parsed = candleSchema.safeParse({
        instrument: request.instrument,
        timeframe: request.timeframe,
        timestamp,
        open: row.open, high: row.high, low: row.low, close: row.close,
        volume: row.volume,
      });
      if (!parsed.success) {
        parseErrors.push({ lineNumber: row.lineNumber, reason: `Schema: ${parsed.error.issues[0]?.message}` });
        continue;
      }
      rawCandles.push(parsed.data);
    } catch (err) {
      parseErrors.push({ lineNumber: row.lineNumber, reason: `Timestamp: ${(err as Error).message}` });
    }
  }

  rawCandles.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const qualityReport = validateCandleSeries(rawCandles);
  const acceptedCandles = qualityReport.accepted.map((idx) => rawCandles[idx]);

  if (acceptedCandles.length === 0) {
    throw new Error("No valid candles after parsing and quality validation");
  }

  const first = acceptedCandles[0];
  const last = acceptedCandles[acceptedCandles.length - 1];
  const frameMs = TIMEFRAME_MS[request.timeframe];
  const periodEndUtc = new Date(Date.parse(last.timestamp) + frameMs).toISOString();
  const digest = createHash("sha256")
    .update(serializeCandlesCanonical(acceptedCandles), "utf8")
    .digest("hex");

  const manifest = datasetManifestSchema.parse({
    datasetId: datasetIdFor(request.providerId, request.instrument, request.timeframe, first.timestamp, periodEndUtc),
    providerId: request.providerId, instrument: request.instrument,
    timeframe: request.timeframe, periodStartUtc: first.timestamp, periodEndUtc,
    recordCount: acceptedCandles.length,
    checksum: { algorithm: "sha256", digest },
    timezone: "UTC", candleTimestampSemantics: "open-time-utc",
    license: request.license, manifestVersion: 1, createdAtUtc: request.createdAtUtc,
  });

  return {
    candles: acceptedCandles, manifest, parseErrors, quality: qualityReport,
    summary: {
      totalCsvLines: csvResult.totalLines, csvParseErrors: parseErrors.length,
      accepted: acceptedCandles.length, quarantined: qualityReport.quarantined.length,
      gaps: qualityReport.gaps.length, truncated: csvResult.truncated,
      periodStartUtc: first.timestamp, periodEndUtc: manifest.periodEndUtc,
      instrument: request.instrument, timeframe: request.timeframe,
    },
  };
}

export function confirmImport(datasetDirectory: string, preview: ImportPreview): StoredDataset {
  const qualitySummary: DatasetQualitySummary = {
    accepted: preview.summary.accepted,
    quarantined: preview.summary.quarantined,
    gaps: preview.summary.gaps,
    duplicates: preview.quality.quarantined.filter((q) => q.reason === "DUPLICATE_TIMESTAMP").length,
    mode: "historical",
  };
  return registerDataset(datasetDirectory, preview.manifest, preview.candles, qualitySummary);
}

