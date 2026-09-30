import { appendFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { MarketDataAuthority } from "@/data/marketAuthority";
import {
  AuthoritativeTwelveDataIngestion,
  TWELVE_DATA_AUTHORITY_MAX_BARS,
  TWELVE_DATA_AUTHORITY_MAX_PAGE_BARS,
  planTwelveDataPages,
  type AuthoritativeTwelveDataOptions,
} from "@/data/providers/twelveDataAuthoritativeIngestion";
import {
  TwelveDataBudget,
  type BoundaryResult,
  type TwelveDataPorts,
  type TwelveDataQuery,
} from "@/data/providers/twelveDataBoundary";
import { openDatabase, openMigratedDatabase } from "@/db/sqlite.mjs";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  while (databases.length) databases.pop()?.close();
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function fresh() {
  const root = mkdtempSync(path.join(tmpdir(), "fdb-r117-"));
  const databasePath = path.join(root, "fdbtrade.sqlite3");
  const database = openMigratedDatabase(databasePath);
  const artifactRoot = path.join(root, "artifacts", "market-data");
  roots.push(root);
  databases.push(database);
  return {
    root,
    databasePath,
    database,
    artifactRoot,
    authority: new MarketDataAuthority(database, artifactRoot),
  };
}

const request = {
  instrument: "EURUSD",
  timeframe: "1h",
  startUtc: "2026-09-29T10:00:00.000Z",
  endUtc: "2026-09-29T14:00:00.000Z",
} as const;

const license = {
  status: "verified",
  source: "Twelve Data API terms",
  evidenceUrl: "https://twelvedata.com/terms",
  note: "Private local analysis; redistribution is not authorized.",
} as const;

const inertPorts: TwelveDataPorts = {
  resolve: async () => { throw new Error("fake executor must not resolve DNS"); },
  send: async () => { throw new Error("fake executor must not send HTTP"); },
  sleep: async () => undefined,
  nowMs: () => 0,
  audit: () => undefined,
};

function datetime(instant: string): string {
  return instant.replace("T", " ").replace(".000Z", "");
}

function goodBody(
  query: TwelveDataQuery,
  mutate?: (values: Array<Record<string, string>>) => void,
): string {
  if (!query.startDateUtc || !query.endDateUtc) throw new Error("range required");
  const frameMs = query.interval === "15min" ? 15 * 60_000
    : query.interval === "1h" ? 60 * 60_000 : 4 * 60 * 60_000;
  const values: Array<Record<string, string>> = [];
  let sequence = 0;
  for (
    let cursor = Date.parse(query.startDateUtc);
    cursor <= Date.parse(query.endDateUtc);
    cursor += frameMs
  ) {
    const open = 1.1 + sequence * 0.001;
    values.push({
      datetime: datetime(new Date(cursor).toISOString()),
      open: open.toFixed(5),
      high: (open + 0.001).toFixed(5),
      low: (open - 0.001).toFixed(5),
      close: (open + 0.0005).toFixed(5),
    });
    sequence += 1;
  }
  mutate?.(values);
  values.reverse();
  return JSON.stringify({
    meta: { symbol: query.pair, interval: query.interval, exchange_timezone: "UTC" },
    values,
    status: "ok",
  });
}

type Executor = NonNullable<AuthoritativeTwelveDataOptions["executeRead"]>;

function executor(options: {
  failCall?: number;
  failureCode?: "rate_budget_exhausted" | "provider_error";
  mutateCall?: number;
  mutate?: (values: Array<Record<string, string>>) => void;
} = {}): { execute: Executor; queries: TwelveDataQuery[] } {
  const queries: TwelveDataQuery[] = [];
  return {
    queries,
    execute: async ({ query }): Promise<BoundaryResult> => {
      queries.push(query);
      const call = queries.length;
      if (call === options.failCall) {
        return {
          ok: false,
          code: options.failureCode ?? "provider_error",
          detail: "scripted",
          attempts: 1,
        };
      }
      return {
        ok: true,
        status: 200,
        bodyText: goodBody(query, call === options.mutateCall ? options.mutate : undefined),
        attempts: 1,
        credentialFingerprint: "0123456789abcdef",
      };
    },
  };
}

function runOptions(executeRead: Executor): AuthoritativeTwelveDataOptions {
  return {
    configDir: "/not-read-by-hermetic-executor",
    createdAtUtc: "2026-09-29T14:00:00.000Z",
    assessedAtUtc: "2026-09-29T14:00:00.000Z",
    license,
    ports: inertPorts,
    budget: new TwelveDataBudget(0),
    pageSizeBars: 2,
    executeRead,
  };
}

describe("R1.17 authoritative Twelve Data ingestion", () => {
  it("plans only aligned, bounded, non-overlapping pages", () => {
    const long = {
      ...request,
      timeframe: "15m" as const,
      startUtc: "2026-01-01T00:00:00.000Z",
      endUtc: new Date(Date.parse("2026-01-01T00:00:00.000Z") + 2_500 * 15 * 60_000).toISOString(),
    };
    const pages = planTwelveDataPages(long);
    expect(pages.map((page) => page.bars)).toEqual([1_000, 1_000, 500]);
    expect(pages[0].endExclusiveUtc).toBe(pages[1].startUtc);
    expect(TWELVE_DATA_AUTHORITY_MAX_PAGE_BARS).toBe(1_000);
    expect(TWELVE_DATA_AUTHORITY_MAX_BARS).toBe(5_000);
    expect(() => planTwelveDataPages({
      ...long,
      endUtc: new Date(Date.parse(long.startUtc) + 5_001 * 15 * 60_000).toISOString(),
    })).toThrow("bounded bar limit");
  });

  it("publishes complete closed pages once through the R0.6 authority", async () => {
    const { database, authority } = fresh();
    const fake = executor();
    const service = new AuthoritativeTwelveDataIngestion(database, authority);
    const first = await service.ingest(request, runOptions(fake.execute));
    expect(first).toMatchObject({ status: "succeeded", executed: true });
    if (first.status !== "succeeded") throw new Error(first.reason);
    expect(first.dataset.manifest).toMatchObject({
      providerId: "twelve-data",
      instrument: "EURUSD",
      timeframe: "1h",
      recordCount: 4,
      license,
    });
    expect(first.dataset).toMatchObject({
      qualityState: "accepted",
      freshnessState: "fresh",
      quality: { accepted: 4, quarantined: 0, gaps: 0, duplicates: 0, mode: "historical" },
    });
    expect(fake.queries).toHaveLength(2);
    expect(fake.queries[0]).toMatchObject({
      outputsize: 2,
      startDateUtc: "2026-09-29T10:00:00.000Z",
      endDateUtc: "2026-09-29T11:00:00.000Z",
    });
    const again = await service.ingest(request, runOptions(fake.execute));
    expect(again).toMatchObject({ status: "succeeded", executed: false });
    expect(fake.queries).toHaveLength(2);
    expect(authority.list()).toHaveLength(1);
  });

  it("publishes nothing after a partial-page failure or rate exhaustion", async () => {
    for (const failureCode of ["provider_error", "rate_budget_exhausted"] as const) {
      const { database, authority } = fresh();
      const fake = executor({ failCall: 2, failureCode });
      const result = await new AuthoritativeTwelveDataIngestion(database, authority)
        .ingest(request, runOptions(fake.execute));
      expect(result).toMatchObject({
        status: "failed",
        executed: true,
        reason: `provider_page_${failureCode}`,
      });
      expect(fake.queries).toHaveLength(2);
      expect(authority.list()).toEqual([]);
    }
  });

  it("rejects stale, duplicate and gapped evidence before publication", async () => {
    const stale = fresh();
    const staleFake = executor();
    await expect(new AuthoritativeTwelveDataIngestion(stale.database, stale.authority).ingest(
      request,
      {
        ...runOptions(staleFake.execute),
        assessedAtUtc: "2026-09-29T17:00:00.000Z",
      },
    )).rejects.toThrow("stale provider ranges");
    expect(staleFake.queries).toEqual([]);
    expect(stale.authority.list()).toEqual([]);

    const duplicate = fresh();
    const duplicateFake = executor({
      mutateCall: 1,
      mutate: (values) => { values[1].datetime = values[0].datetime; },
    });
    const duplicateResult = await new AuthoritativeTwelveDataIngestion(
      duplicate.database,
      duplicate.authority,
    ).ingest(request, runOptions(duplicateFake.execute));
    expect(duplicateResult).toMatchObject({
      status: "failed",
      reason: "provider_evidence_timestamp_duplicate",
    });
    expect(duplicate.authority.list()).toEqual([]);

    const gap = fresh();
    const gapFake = executor({
      mutateCall: 1,
      mutate: (values) => { values.splice(1, 1); },
    });
    const gapResult = await new AuthoritativeTwelveDataIngestion(
      gap.database,
      gap.authority,
    ).ingest(request, runOptions(gapFake.execute));
    expect(gapResult).toMatchObject({
      status: "failed",
      reason: "provider_session_gap",
    });
    expect(gap.authority.list()).toEqual([]);
  });

  it("recovers a crash idempotently, then detects artifact tampering", async () => {
    const first = fresh();
    const fake = executor();
    await expect(new AuthoritativeTwelveDataIngestion(first.database, first.authority).ingest(
      request,
      {
        ...runOptions(fake.execute),
        faultAfterPublication: () => { throw new Error("simulated crash"); },
      },
    )).rejects.toThrow("simulated crash");
    expect(first.authority.list()).toHaveLength(1);
    first.database.close();
    databases.pop();

    const reopened = openDatabase({ databasePath: first.databasePath, mustExist: true });
    databases.push(reopened);
    const authority = new MarketDataAuthority(reopened, first.artifactRoot);
    expect(authority.recover().recoveredJobs).toBe(1);
    const resumed = await new AuthoritativeTwelveDataIngestion(reopened, authority)
      .ingest(request, runOptions(fake.execute));
    expect(resumed).toMatchObject({ status: "succeeded", executed: true });
    const duplicate = await new AuthoritativeTwelveDataIngestion(reopened, authority)
      .ingest(request, runOptions(fake.execute));
    expect(duplicate).toMatchObject({ status: "succeeded", executed: false });
    expect(authority.list()).toHaveLength(1);

    const shaRoot = path.join(first.artifactRoot, "sha256");
    const prefix = readdirSync(shaRoot)[0] as string;
    const artifact = path.join(shaRoot, prefix, readdirSync(path.join(shaRoot, prefix))[0] as string);
    appendFileSync(artifact, "tamper", "utf8");
    if (resumed.status !== "succeeded") throw new Error(resumed.reason);
    expect(() => authority.load(resumed.dataset.manifest.datasetId)).toThrow("integrity failure");
  });

  it("requires official verified licensing and never falls back to fixture data", async () => {
    const { database, authority } = fresh();
    const fake = executor();
    await expect(new AuthoritativeTwelveDataIngestion(database, authority).ingest(
      request,
      {
        ...runOptions(fake.execute),
        license: { ...license, status: "unverified", evidenceUrl: null },
      },
    )).rejects.toThrow("verified license evidence");
    expect(fake.queries).toEqual([]);
    expect(authority.list()).toEqual([]);
  });
});