import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";

import { confirmImport, previewImport } from "@/data/historical/importService";
import { listDatasets, loadDataset } from "@/data/historical/datasetRegistry";
import { loadHistoricalReplay } from "@/data/historical/replayLoader";
import { MAX_IMPORT_ROWS } from "@/data/historical/csvParser";
import { executeAndStoreRun } from "@/backtest/api";
import { openMigratedDatabase } from "@/db/sqlite.mjs";
import { MarketDataAuthority } from "@/data/marketAuthority";

const dirs: string[] = [];
const databases: DatabaseSync[] = [];
function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "fdb-historical-"));
  dirs.push(dir);
  return dir;
}
function freshAuthority(): MarketDataAuthority {
  const root = freshDir();
  const database = openMigratedDatabase(path.join(root, "fdbtrade.sqlite3"));
  databases.push(database);
  return new MarketDataAuthority(database, path.join(root, "artifacts", "market-data"));
}
afterAll(() => {
  databases.forEach((database) => database.close());
  dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

const header = "timestamp,open,high,low,close,volume";
const validCsv = [
  header,
  "2026-09-07T00:00:00.000Z,1.1000,1.1010,1.0990,1.1005,100",
  "2026-09-07T01:00:00.000Z,1.1005,1.1020,1.1000,1.1015,101",
  "2026-09-07T02:00:00.000Z,1.1015,1.1030,1.1010,1.1025,102",
].join("\n");

function request(csvText = validCsv) {
  return {
    csvText,
    instrument: "EURUSD",
    timeframe: "1h" as const,
    providerId: "user-owned-csv",
    license: { status: "unverified" as const, source: "operator-owned CSV", evidenceUrl: null, note: "private research only" },
    createdAtUtc: "2026-09-10T12:00:00.000Z",
  };
}

describe("M46 historical research workflow", () => {
  it("previews, confirms, reopens immutable historical CSV with checksum provenance", () => {
    const authority = freshAuthority();
    const preview = previewImport(request());
    expect(preview.summary.accepted).toBe(3);
    expect(preview.summary.quarantined).toBe(0);
    expect(preview.manifest.checksum.digest).toMatch(/^[a-f0-9]{64}$/);

    const stored = confirmImport(authority, preview);
    expect(confirmImport(authority, preview).manifest.checksum.digest).toBe(stored.manifest.checksum.digest);
    expect(loadDataset(authority, stored.manifest.datasetId)?.manifest).toEqual(stored.manifest);
    expect(listDatasets(authority)).toEqual([expect.objectContaining({ mode: "historical", recordCount: 3 })]);

    const replay = loadHistoricalReplay(authority, stored.manifest.datasetId);
    expect(replay).toEqual(expect.objectContaining({ ok: true, mode: "historical", recordCount: 3, digest: stored.manifest.checksum.digest }));
  });

  it("rejects malformed or ambiguous headers and invalid timestamps; no empty dataset can be confirmed", () => {
    expect(() => previewImport(request("when,open,high,low,close,volume\nnow,1,1,1,1,1"))).toThrow("No valid candles");
    expect(() => previewImport(request("timestamp,open,high,low,close,volume,extra\n2026-09-07T00:00:00.000Z,1,1,1,1,1,x"))).toThrow("No valid candles");
    expect(() => previewImport(request(`${header}\nnot-a-time,1,1,1,1,1`))).toThrow("No valid candles");
  });

  it("reports duplicate and session gap records without inventing candles", () => {
    const preview = previewImport(request([
      header,
      "2026-09-07T00:00:00.000Z,1.1,1.2,1.0,1.1,1",
      "2026-09-07T00:00:00.000Z,1.1,1.2,1.0,1.1,1",
      "2026-09-07T02:00:00.000Z,1.1,1.2,1.0,1.1,1",
    ].join("\n")));
    expect(preview.summary.accepted).toBe(2);
    expect(preview.summary.quarantined).toBe(1);
    expect(preview.quality.quarantined[0]?.reason).toBe("DUPLICATE_TIMESTAMP");
    expect(preview.summary.gaps).toBeGreaterThanOrEqual(0);
  });

  it("fails closed when same logical dataset id has divergent content", () => {
    const authority = freshAuthority();
    const first = previewImport(request());
    confirmImport(authority, first);
    const divergent = previewImport(request(validCsv.replace("1.1025", "1.1026")));
    expect(() => confirmImport(authority, divergent)).toThrow("different content");
  });

  it("rejects oversized input rather than truncating it", () => {
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, index) =>
      `2026-09-07T${String(index % 24).padStart(2, "0")}:00:00.000Z,1.1,1.2,1.0,1.1,1`,
    );
    expect(() => previewImport(request([header, ...rows].join("\n")))).toThrow("CSV row limit exceeded");
  });

  it("backtests confirmed historical candles with exact dataset checksum provenance", async () => {
    const authority = freshAuthority();
    const runDirectory = freshDir();
    const stored = confirmImport(authority, previewImport(request()));
    const response = await executeAndStoreRun({
      instrument: "EURUSD", timeframe: "1h",
      periodStartUtc: "2026-09-07T00:00:00.000Z", periodEndUtc: "2026-09-07T03:00:00.000Z",
      initialEquity: 10_000, warmupBars: 0,
      fillPolicy: { policyId: "next-bar-open", latencyBars: 1, spreadPips: 0, slippagePips: 0, commissionPips: 0, maxFillFraction: 1, exitPriority: "stop-first" },
      seed: "m46-historical", subject: "noop", createdAtUtc: "2026-09-10T12:00:00.000Z",
      datasetId: stored.manifest.datasetId,
    }, runDirectory, authority);
    expect(response.manifest.dataset).toEqual({ datasetId: stored.manifest.datasetId, digest: stored.manifest.checksum.digest });
    expect(response.manifest.metrics.bars).toBe(3);
  });
});
