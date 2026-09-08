/**
 * Dataset manifest tests (P02-05).
 *
 * Acceptance: "A dataset can be uniquely identified and replayed from its
 * manifest." Covers: deterministic ids, checksum verification, replay
 * equality, license-evidence enforcement, malformed manifests, empty
 * datasets.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  Candle,
  DatasetManifest,
  datasetManifestSchema,
  serializeCandlesCanonical,
} from "@fdbtrade/contracts";

import { buildDatasetManifest, verifyDatasetManifest } from "@/data/manifest";
import { FixtureProvider } from "@/data/providers/fixture";

const SYNTHETIC_LICENSE = {
  status: "synthetic" as const,
  source: "FdbTrade deterministic fixture provider (ADR-0010)",
  evidenceUrl: null,
  note: "Synthetic data; no third-party license claim.",
};

function candles(): Candle[] {
  return [
    {
      instrument: "EURUSD",
      timeframe: "1h",
      timestamp: "2026-09-08T10:00:00.000Z",
      open: 1.1,
      high: 1.101,
      low: 1.099,
      close: 1.1005,
      volume: null,
    },
    {
      instrument: "EURUSD",
      timeframe: "1h",
      timestamp: "2026-09-08T11:00:00.000Z",
      open: 1.1005,
      high: 1.102,
      low: 1.1,
      close: 1.101,
      volume: null,
    },
  ];
}

describe("buildDatasetManifest (P02-05)", () => {
  it("derives a deterministic, unique, schema-valid manifest", () => {
    const a = buildDatasetManifest("fixture", candles(), SYNTHETIC_LICENSE, {
      createdAtUtc: "2026-09-08T12:00:00.000Z",
    });
    const b = buildDatasetManifest("fixture", candles(), SYNTHETIC_LICENSE, {
      createdAtUtc: "2026-09-08T12:00:00.000Z",
    });
    expect(a).toEqual(b);
    // Period end is exclusive (last open + 1h frame).
    expect(a.datasetId).toBe(
      "dataset|fixture|EURUSD|1h|2026-09-08T10:00:00.000Z|2026-09-08T12:00:00.000Z",
    );
    expect(a.recordCount).toBe(2);
    expect(a.timezone).toBe("UTC");
    expect(a.candleTimestampSemantics).toBe("open-time-utc");
    expect(a.checksum.algorithm).toBe("sha256");
    expect(a.checksum.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(datasetManifestSchema.safeParse(a).success).toBe(true);
  });

  it("checksum equals sha256 of the canonical serialization", () => {
    const batch = candles();
    const manifest = buildDatasetManifest("fixture", batch, SYNTHETIC_LICENSE, {
      createdAtUtc: "2026-09-08T12:00:00.000Z",
    });
    const expected = createHash("sha256")
      .update(serializeCandlesCanonical(batch), "utf8")
      .digest("hex");
    expect(manifest.checksum.digest).toBe(expected);
  });

  it("rejects empty datasets (fail closed)", () => {
    expect(() =>
      buildDatasetManifest("fixture", [], SYNTHETIC_LICENSE, {
        createdAtUtc: "2026-09-08T12:00:00.000Z",
      }),
    ).toThrow(/empty/);
  });

  it("rejects heterogeneous or descending batches", () => {
    const mixed = [...candles(), { ...candles()[0], instrument: "GBPUSD" }];
    expect(() =>
      buildDatasetManifest("fixture", mixed, SYNTHETIC_LICENSE, {
        createdAtUtc: "2026-09-08T12:00:00.000Z",
      }),
    ).toThrow(/homogeneous/);
    const descending = [candles()[1], candles()[0]];
    expect(() =>
      buildDatasetManifest("fixture", descending, SYNTHETIC_LICENSE, {
        createdAtUtc: "2026-09-08T12:00:00.000Z",
      }),
    ).toThrow(/ascending/);
  });
});

describe("verifyDatasetManifest (P02-05) — replay", () => {
  it("verifies a replayed batch: dataset identified and replayed", async () => {
    // Build the dataset FROM the deterministic fixture provider, then
    // replay the same range and verify against the manifest.
    const provider = new FixtureProvider();
    const batch = await provider.getHistoricalCandles({
      instrument: "EURUSD",
      timeframe: "1h",
      startUtc: "2026-09-08T10:00:00.000Z",
      endUtc: "2026-09-08T12:00:00.000Z",
    });
    const manifest = buildDatasetManifest("fixture", batch, SYNTHETIC_LICENSE, {
      createdAtUtc: "2026-09-08T12:00:00.000Z",
    });
    const replayed = await provider.getHistoricalCandles({
      instrument: "EURUSD",
      timeframe: "1h",
      startUtc: manifest.periodStartUtc,
      endUtc: manifest.periodEndUtc,
    });
    const result = verifyDatasetManifest(manifest, replayed);
    expect(result).toMatchObject({
      ok: true,
      datasetId: manifest.datasetId,
      recordCount: manifest.recordCount,
    });
  });

  it("detects a mutated candle (checksum mismatch)", () => {
    const manifest = buildDatasetManifest("fixture", candles(), SYNTHETIC_LICENSE, {
      createdAtUtc: "2026-09-08T12:00:00.000Z",
    });
    const tampered = candles();
    tampered[0].close = 1.55;
    const result = verifyDatasetManifest(manifest, tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/checksum/);
  });

  it("detects record-count mismatch", () => {
    const manifest = buildDatasetManifest("fixture", candles(), SYNTHETIC_LICENSE, {
      createdAtUtc: "2026-09-08T12:00:00.000Z",
    });
    const result = verifyDatasetManifest(manifest, candles().slice(0, 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/record count/);
  });

  it("detects foreign records in the batch", () => {
    const manifest = buildDatasetManifest("fixture", candles(), SYNTHETIC_LICENSE, {
      createdAtUtc: "2026-09-08T12:00:00.000Z",
    });
    const foreign = candles().map((c) => ({ ...c, instrument: "GBPUSD" as const }));
    const result = verifyDatasetManifest(manifest, foreign);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/foreign/);
  });

  it("rejects malformed manifests (schema)", () => {
    const manifest = buildDatasetManifest("fixture", candles(), SYNTHETIC_LICENSE, {
      createdAtUtc: "2026-09-08T12:00:00.000Z",
    });
    const bad = { ...manifest, recordCount: -1 };
    const result = verifyDatasetManifest(bad as DatasetManifest, candles());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/invalid manifest/);
  });
});

describe("license evidence enforcement (P02-05 non-goal guard)", () => {
  const build = (license: object) =>
    buildDatasetManifest("fixture", candles(), license as never, {
      createdAtUtc: "2026-09-08T12:00:00.000Z",
    });

  it("verified claims REQUIRE an evidence URL", () => {
    expect(() =>
      build({
        status: "verified",
        source: "some feed",
        evidenceUrl: null,
        note: "",
      }),
    ).toThrow();
    const manifest = build({
      status: "verified",
      source: "some feed",
      evidenceUrl: "https://example.com/license",
      note: "",
    });
    expect(manifest.license.status).toBe("verified");
  });

  it("unverified is the honest default and needs no evidence", () => {
    const manifest = build({
      status: "unverified",
      source: "unknown provider",
      evidenceUrl: null,
      note: "license status unknown",
    });
    expect(manifest.license.status).toBe("unverified");
  });

  it("unknown license statuses are rejected", () => {
    const manifest = build(SYNTHETIC_LICENSE);
    const bad = { ...manifest, license: { ...manifest.license, status: "maybe" } };
    expect(datasetManifestSchema.safeParse(bad).success).toBe(false);
  });
});

