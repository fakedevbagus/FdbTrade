/**
 * Dataset manifest builder + verifier (P02-05).
 *
 * Acceptance: "A dataset can be uniquely identified and replayed from its
 * manifest." The manifest is derived deterministically from a canonical
 * candle batch (P02-02/P02-03 output); verification recomputes the
 * canonical sha256 and compares — replay = re-fetch the same range and
 * verify the checksum matches, proving byte-identical data.
 */
import { createHash } from "node:crypto";

import {
  Candle,
  DatasetManifest,
  TIMEFRAME_MS,
  datasetIdFor,
  datasetManifestSchema,
  serializeCandlesCanonical,
} from "@fdbtrade/contracts";

/**
 * Build a manifest from a canonical candle batch.
 *
 * Deterministic for the same inputs; period/count/checksum are all derived.
 * `license` is supplied by the caller — never inferred (a synthetic fixture
 * dataset must be declared `synthetic`, third-party data `unverified` unless
 * evidence exists).
 */
export function buildDatasetManifest(
  providerId: string,
  candles: readonly Candle[],
  license: DatasetManifest["license"],
  options: { createdAtUtc: string },
): DatasetManifest {
  if (candles.length === 0) {
    throw new Error("cannot build a manifest for an empty dataset");
  }
  const first = candles[0];
  const last = candles[candles.length - 1];

  // The batch must be homogeneous (one instrument/timeframe).
  for (const candle of candles) {
    if (candle.instrument !== first.instrument || candle.timeframe !== first.timeframe) {
      throw new Error("dataset manifest requires a homogeneous candle batch");
    }
  }
  // And ordered: first open is the earliest, last open the latest.
  if (Date.parse(first.timestamp) >= Date.parse(last.timestamp)) {
    throw new Error("dataset candles must be ascending by open time");
  }

  const digest = createHash("sha256")
    .update(serializeCandlesCanonical(candles), "utf8")
    .digest("hex");

  // Period is [first open, last open + frame): whole bars, exclusive end —
  // a replay fetch over this period returns exactly this batch (session
  // closures inside the range simply produce no bars).
  const frameMs = TIMEFRAME_MS[first.timeframe];
  const periodEndUtc = new Date(
    Date.parse(last.timestamp) + frameMs,
  ).toISOString();

  return datasetManifestSchema.parse({
    datasetId: datasetIdFor(
      providerId,
      first.instrument,
      first.timeframe,
      first.timestamp,
      periodEndUtc,
    ),
    providerId,
    instrument: first.instrument,
    timeframe: first.timeframe,
    periodStartUtc: first.timestamp,
    periodEndUtc,
    recordCount: candles.length,
    checksum: { algorithm: "sha256", digest },
    timezone: "UTC",
    candleTimestampSemantics: "open-time-utc",
    license,
    manifestVersion: 1,
    createdAtUtc: options.createdAtUtc,
  });
}

/** Verification outcome: exact match or an explicit mismatch reason. */
export type ManifestVerification =
  | { ok: true; datasetId: string; recordCount: number }
  | { ok: false; reason: string };

/**
 * Verify a candle batch against a manifest.
 *
 * Checks: schema-valid manifest, homogeneous batch, count, canonical
 * checksum digest. Deterministic — no clock, no network.
 */
export function verifyDatasetManifest(
  manifest: DatasetManifest,
  candles: readonly Candle[],
): ManifestVerification {
  const parsed = datasetManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    return { ok: false, reason: `invalid manifest: ${parsed.error.issues[0]?.message}` };
  }
  for (const candle of candles) {
    if (
      candle.instrument !== manifest.instrument ||
      candle.timeframe !== manifest.timeframe
    ) {
      return {
        ok: false,
        reason: `batch contains foreign records (${candle.instrument}/${candle.timeframe})`,
      };
    }
  }
  if (candles.length !== manifest.recordCount) {
    return {
      ok: false,
      reason: `record count mismatch: manifest ${manifest.recordCount}, batch ${candles.length}`,
    };
  }
  const digest = createHash("sha256")
    .update(serializeCandlesCanonical(candles), "utf8")
    .digest("hex");
  if (digest !== manifest.checksum.digest) {
    return { ok: false, reason: `checksum mismatch: expected ${manifest.checksum.digest}, got ${digest}` };
  }
  return { ok: true, datasetId: manifest.datasetId, recordCount: candles.length };
}
