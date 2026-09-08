/**
 * Historical dataset manifest contracts (P02-05).
 *
 * A manifest makes a dataset UNIQUELY IDENTIFIABLE and REPLAYABLE: it names
 * the provider, instrument, timeframe, period, record count, a content
 * checksum over the canonical candle serialization, the timezone policy
 * (UTC — ADR-0004) and honest license/source notes.
 *
 * Non-goal (prompt): a dataset is NEVER claimed licensed without
 * evidence — `license` is explicit: either a verified statement with a
 * source URL/evidence, or "unverified". Synthetic fixture datasets are
 * marked as such with no license claim.
 */
import { z } from "zod";

import { instrumentIdSchema } from "./instrument";
import { providerIdSchema } from "./provider";
import { TIMEFRAME_MS, timeframeSchema, utcInstantSchema } from "./time";
import type { Candle } from "./candle";

/** License status — the only honest default for third-party data. */
export const LICENSE_STATUSES = ["verified", "unverified", "synthetic"] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

/** A verified claim REQUIRES evidence — enforced, not trusted. */
export const licenseNoteSchema = z
  .object({
    status: z.enum(LICENSE_STATUSES),
    /** Human-readable source description (docs, not credentials). */
    source: z.string().min(1),
    /** Optional evidence URL/documentation reference required when verified. */
    evidenceUrl: z.string().url().nullable(),
    /** Free-text note (redistribution constraints, etc.). */
    note: z.string().min(0),
  })
  .strict()
  .superRefine((note, ctx) => {
    if (note.status === "verified") {
      if (!note.evidenceUrl) {
        ctx.addIssue({
          code: "custom",
          path: ["evidenceUrl"],
          message: "verified license claims require an evidenceUrl",
        });
      } else if (!/^https?:\/\//.test(note.evidenceUrl)) {
        ctx.addIssue({
          code: "custom",
          path: ["evidenceUrl"],
          message: "evidenceUrl must be an http(s) URL",
        });
      }
    }
  });

export type LicenseNote = z.infer<typeof licenseNoteSchema>;

/** Checksum descriptor for the manifest payload. */
export const datasetChecksumSchema = z
  .object({
    /** Algorithm identifier — only sha256 exists (adding one is an ADR). */
    algorithm: z.literal("sha256"),
    /** Hex digest (lowercase) over the canonical candle serialization. */
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type DatasetChecksum = z.infer<typeof datasetChecksumSchema>;

/**
 * The dataset manifest. `datasetId` is globally unique (provider +
 * instrument + timeframe + period is the natural key; the id makes it
 * referenceable in research provenance).
 */
export const datasetManifestSchema = z
  .object({
    datasetId: z.string().min(1).max(128),
    providerId: providerIdSchema,
    instrument: instrumentIdSchema,
    timeframe: timeframeSchema,
    /** Dataset period: inclusive start, exclusive end (UTC instants). */
    periodStartUtc: utcInstantSchema,
    periodEndUtc: utcInstantSchema,
    /** Number of canonical candles in the dataset. */
    recordCount: z.number().int().min(0),
    checksum: datasetChecksumSchema,
    /** Timezone policy — locked to UTC (ADR-0004). */
    timezone: z.literal("UTC"),
    /** Candle timestamp semantics, restated for replay (ADR-0009). */
    candleTimestampSemantics: z.literal("open-time-utc"),
    license: licenseNoteSchema,
    /** Manifest format version. */
    manifestVersion: z.literal(1),
    /** UTC instant the manifest was created (metadata only). */
    createdAtUtc: utcInstantSchema,
  })
  .strict()
  .refine((m) => m.periodStartUtc < m.periodEndUtc, {
    message: "periodStartUtc must be before periodEndUtc",
    path: ["periodStartUtc"],
  });

export type DatasetManifest = z.infer<typeof datasetManifestSchema>;

// ---------------------------------------------------------------------------
// Canonical serialization + dataset identity (shared with the Python mirror)
// ---------------------------------------------------------------------------

/**
 * Canonical serialization of one candle for checksumming: pipe-joined fields
 * in a FIXED order with NO trailing newline. Volume uses `-` for null. This
 * exact byte form is the hash input in TS and Python — changing it is a
 * cross-layer breaking change (tests pin it).
 */
export function serializeCandleCanonical(candle: Candle): string {
  const volume = candle.volume === null ? "-" : String(candle.volume);
  return [
    candle.instrument,
    candle.timeframe,
    candle.timestamp,
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    volume,
  ].join("|");
}

/** Canonical multi-line serialization (newline-joined, no trailing newline). */
export function serializeCandlesCanonical(candles: readonly Candle[]): string {
  return candles.map(serializeCandleCanonical).join("\n");
}

/**
 * Deterministic dataset id: `dataset|provider|instrument|timeframe|start|end`.
 * The natural identity key — two manifests with the same id describe the
 * same logical dataset.
 */
export function datasetIdFor(
  providerId: string,
  instrument: string,
  timeframe: string,
  periodStartUtc: string,
  periodEndUtc: string,
): string {
  return ["dataset", providerId, instrument, timeframe, periodStartUtc, periodEndUtc]
    .join("|");
}

/**
 * Period alignment invariant for a dataset: start and end must sit on the
 * timeframe grid (a dataset covers whole bars only).
 */
export function isManifestPeriodAligned(
  startUtc: string,
  endUtc: string,
  timeframe: DatasetManifest["timeframe"],
): boolean {
  const frameMs = TIMEFRAME_MS[timeframe];
  return (
    Date.parse(startUtc) % frameMs === 0 && Date.parse(endUtc) % frameMs === 0
  );
}

