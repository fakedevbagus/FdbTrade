/** Compatibility surface over the R0.6 market-data authority. */
import type { Candle, DatasetManifest } from "@fdbtrade/contracts";

import {
  MarketDataAuthority,
  type DatasetListEntry,
  type DatasetQualitySummary,
  type StoredDataset,
} from "@/data/marketAuthority";

export type DataSourceMode = DatasetQualitySummary["mode"];
export const DATA_SOURCE_MODES = ["fixture", "historical"] as const;
export type { DatasetListEntry, DatasetQualitySummary, StoredDataset };

export function registerDataset(
  authority: MarketDataAuthority,
  manifest: DatasetManifest,
  candles: readonly Candle[],
  quality: DatasetQualitySummary,
  assessedAtUtc: string,
): StoredDataset {
  return authority.publish(manifest, candles, quality, { assessedAtUtc });
}

export function loadDataset(
  authority: MarketDataAuthority,
  datasetId: string,
): StoredDataset | null {
  return authority.load(datasetId);
}

export function listDatasets(authority: MarketDataAuthority): DatasetListEntry[] {
  return authority.list();
}

export function verifyDataset(dataset: StoredDataset): { ok: boolean; reason?: string } {
  return dataset.candles.length === dataset.manifest.recordCount
    ? { ok: true }
    : {
        ok: false,
        reason: `record count mismatch: manifest ${dataset.manifest.recordCount}, candles ${dataset.candles.length}`,
      };
}
