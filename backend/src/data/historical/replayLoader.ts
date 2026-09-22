/**
 * Historical replay loader (M46).
 *
 * Loads a registered dataset for replay/backtest with integrity verification.
 * Cannot silently substitute fixture data — the source mode is explicit and
 * verified at load time.
 */
import { createHash } from "node:crypto";

import { type Candle, serializeCandlesCanonical } from "@fdbtrade/contracts";

import {
  loadDataset,
  type StoredDataset,
  type DataSourceMode,
} from "./datasetRegistry";
import type { MarketDataAuthority } from "@/data/marketAuthority";

export interface ReplayLoadResult {
  ok: true;
  candles: readonly Candle[];
  datasetId: string;
  digest: string;
  mode: DataSourceMode;
  recordCount: number;
}

export interface ReplayLoadError {
  ok: false;
  reason: string;
}

/**
 * Load a historical dataset for replay. Verifies checksum integrity.
 * Fails closed if dataset not found, corrupt, or fixture-sourced.
 */
export function loadHistoricalReplay(
  authority: MarketDataAuthority,
  datasetId: string,
): ReplayLoadResult | ReplayLoadError {
  const dataset = loadDataset(authority, datasetId);
  if (!dataset) {
    return { ok: false, reason: `Dataset ${datasetId} not found` };
  }

  // Verify checksum.
  const digest = createHash("sha256")
    .update(serializeCandlesCanonical(dataset.candles), "utf8")
    .digest("hex");
  if (digest !== dataset.manifest.checksum.digest) {
    return { ok: false, reason: `Checksum mismatch for dataset ${datasetId}` };
  }

  // Explicit mode check — fixture datasets are never silently replayed
  // as historical data.
  if (dataset.quality.mode === "fixture") {
    return {
      ok: false,
      reason: `Dataset ${datasetId} is fixture data — use fixture provider for fixture replay`,
    };
  }

  return {
    ok: true,
    candles: dataset.candles,
    datasetId: dataset.manifest.datasetId,
    digest,
    mode: dataset.quality.mode,
    recordCount: dataset.candles.length,
  };
}

/**
 * Load any registered dataset (including fixture-sourced ones) for
 * backtest/research. Still verifies integrity.
 */
export function loadDatasetForBacktest(
  authority: MarketDataAuthority,
  datasetId: string,
): ReplayLoadResult | ReplayLoadError {
  const dataset = loadDataset(authority, datasetId);
  if (!dataset) {
    return { ok: false, reason: `Dataset ${datasetId} not found` };
  }

  const digest = createHash("sha256")
    .update(serializeCandlesCanonical(dataset.candles), "utf8")
    .digest("hex");
  if (digest !== dataset.manifest.checksum.digest) {
    return { ok: false, reason: `Checksum mismatch for dataset ${datasetId}` };
  }

  return {
    ok: true,
    candles: dataset.candles,
    datasetId: dataset.manifest.datasetId,
    digest,
    mode: dataset.quality.mode,
    recordCount: dataset.candles.length,
  };
}
