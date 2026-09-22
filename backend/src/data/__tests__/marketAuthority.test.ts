import { appendFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { AuthoritativeFixtureIngestion } from "@/data/authoritativeIngestion";
import {
  APPROVED_MARKET_INSTRUMENTS,
  APPROVED_MARKET_TIMEFRAMES,
  MarketDataAuthority,
  assertApprovedMarketScope,
} from "@/data/marketAuthority";
import { FixtureProvider } from "@/data/providers/fixture";
import { openDatabase, openMigratedDatabase } from "@/db/sqlite.mjs";

const roots: string[] = [];
const databases: DatabaseSync[] = [];

function fresh(): { root: string; databasePath: string; database: DatabaseSync; authority: MarketDataAuthority } {
  const root = mkdtempSync(path.join(tmpdir(), "fdb-r06-"));
  const databasePath = path.join(root, "fdbtrade.sqlite3");
  const database = openMigratedDatabase(databasePath);
  const authority = new MarketDataAuthority(database, path.join(root, "artifacts", "market-data"));
  roots.push(root);
  databases.push(database);
  return { root, databasePath, database, authority };
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const request = {
  instrument: "EURUSD",
  timeframe: "15m",
  startUtc: "2026-09-08T10:00:00.000Z",
  endUtc: "2026-09-08T12:00:00.000Z",
} as const;

const options = {
  createdAtUtc: "2026-09-08T12:00:00.000Z",
  assessedAtUtc: "2026-09-08T12:00:00.000Z",
};

describe("R0.6 market-data and artifact authority", () => {
  it("pins exactly seven majors and the approved intraday timeframes", () => {
    expect(APPROVED_MARKET_INSTRUMENTS).toEqual([
      "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD",
    ]);
    expect(APPROVED_MARKET_TIMEFRAMES).toEqual(["15m", "1h", "4h"]);
    expect(() => assertApprovedMarketScope("XAUUSD", "1h")).toThrow("outside R0.6");
    expect(() => assertApprovedMarketScope("EURUSD", "5m")).toThrow("outside R0.6");
  });

  it("rejects a look-ahead freshness assessment", async () => {
    const { database, authority } = fresh();
    const service = new AuthoritativeFixtureIngestion(database, authority, new FixtureProvider());
    await expect(service.ingest(request, {
      ...options,
      assessedAtUtc: "2026-09-08T11:59:59.999Z",
    })).rejects.toThrow("cannot precede");
  });

  it("publishes fixture bytes before transactional metadata and survives reopen", async () => {
    const { database, databasePath, authority } = fresh();
    const service = new AuthoritativeFixtureIngestion(database, authority, new FixtureProvider());
    const first = await service.ingest(request, options);
    expect(first).toMatchObject({ status: "succeeded", executed: true });
    if (first.status !== "succeeded") throw new Error(first.reason);
    expect(first.dataset.freshnessState).toBe("fresh");
    expect(first.dataset.qualityState).toBe("accepted");
    expect(authority.list()).toEqual([
      expect.objectContaining({ instrument: "EURUSD", timeframe: "15m", mode: "fixture" }),
    ]);
    database.close();
    databases.pop();

    const reopened = openDatabase({ databasePath, mustExist: true });
    databases.push(reopened);
    const reopenedAuthority = new MarketDataAuthority(reopened, authority.artifactRoot);
    const stored = reopenedAuthority.load(first.dataset.manifest.datasetId);
    expect(stored?.candles).toEqual(first.dataset.candles);
    expect(reopenedAuthority.recover()).toMatchObject({
      verifiedDatasets: 1,
      corruptDatasets: [],
      recoveredJobs: 0,
    });
  });

  it("recovers a crash after publication and completes the same job once", async () => {
    const { database, databasePath, authority } = fresh();
    const service = new AuthoritativeFixtureIngestion(database, authority, new FixtureProvider());
    await expect(service.ingest(request, {
      ...options,
      faultAfterPublication: () => { throw new Error("simulated crash"); },
    })).rejects.toThrow("simulated crash");
    expect(authority.list()).toHaveLength(1);
    database.close();
    databases.pop();

    const reopened = openDatabase({ databasePath, mustExist: true });
    databases.push(reopened);
    const reopenedAuthority = new MarketDataAuthority(reopened, authority.artifactRoot);
    expect(reopenedAuthority.recover().recoveredJobs).toBe(1);
    const resumed = await new AuthoritativeFixtureIngestion(
      reopened,
      reopenedAuthority,
      new FixtureProvider(),
    ).ingest(request, options);
    expect(resumed).toMatchObject({ status: "succeeded", executed: true });
    const duplicate = await new AuthoritativeFixtureIngestion(
      reopened,
      reopenedAuthority,
      new FixtureProvider(),
    ).ingest(request, options);
    expect(duplicate).toMatchObject({ status: "succeeded", executed: false });
    expect(reopenedAuthority.list()).toHaveLength(1);
  });

  it("fails closed on artifact tampering and SQLite metadata mutation", async () => {
    const { database, authority } = fresh();
    const result = await new AuthoritativeFixtureIngestion(
      database,
      authority,
      new FixtureProvider(),
    ).ingest(request, options);
    if (result.status !== "succeeded") throw new Error(result.reason);
    expect(() => database.prepare(`
      UPDATE market_data_datasets SET provider_id = 'changed'
      WHERE dataset_id = ?
    `).run(result.dataset.manifest.datasetId)).toThrow("immutable");

    const shaRoot = path.join(authority.artifactRoot, "sha256");
    const prefix = readdirSync(shaRoot)[0] as string;
    const artifact = path.join(shaRoot, prefix, readdirSync(path.join(shaRoot, prefix))[0] as string);
    appendFileSync(artifact, "tamper", "utf8");
    expect(() => authority.load(result.dataset.manifest.datasetId)).toThrow("integrity failure");
    expect(authority.recover().corruptDatasets).toEqual([result.dataset.manifest.datasetId]);
  });
});
