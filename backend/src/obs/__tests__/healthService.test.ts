/** R0.11 health behavior over the durable R0.9 SQLite risk latch. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthResult } from "@/auth/store";
import type { HealthCheck } from "@fdbtrade/contracts";

const SESSION_TOKEN = "test-session-token-health";
const AUTH_RESULT: AuthResult = {
  session: {
    id: "sess-1",
    userId: "user-1",
    createdAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
  user: { id: "user-1", username: "owner", isActive: true, mfaEnabled: false },
};
const runtime = vi.hoisted(() => ({ database: undefined as DatabaseSync | undefined }));

vi.mock("@/auth/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/auth/store")>();
  return {
    ...actual,
    getSessionByToken: vi.fn(async (token: string) =>
      token === SESSION_TOKEN ? AUTH_RESULT : null,
    ),
  };
});

vi.mock("@/db/client", () => ({
  checkDatabaseHealth: vi.fn(async () => ({
    status: "ok",
    latencyMs: 3,
    errorCode: null,
  })),
  getDatabase: vi.fn(() => {
    if (!runtime.database) throw new Error("test database is not initialized");
    return runtime.database;
  }),
}));

import { GET as getHealth, POST as postHealth } from "@/app/api/admin/health/route";
import { MarketDataAuthority } from "@/data/marketAuthority";
import { openDatabase, openMigratedDatabase } from "@/db/sqlite.mjs";
import {
  currentHealthSnapshot,
  durableRiskState,
} from "@/obs/healthService";
import { durableHealthEvidence } from "@/obs/durableHealthProjection";
import { RiskPaperAuthority } from "@/paper/riskPaperAuthority";

const roots: string[] = [];

beforeEach(() => {
  runtime.database = openMigratedDatabase();
  const authority = new RiskPaperAuthority(
    runtime.database,
    new MarketDataAuthority(runtime.database, path.join(tmpdir(), "fdb-health-default-artifacts")),
  );
  authority.registerBaseline("2026-09-23T00:00:00.000Z");
});

afterEach(() => {
  runtime.database?.close();
  runtime.database = undefined;
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function request(pathname: string, init?: RequestInit): Request {
  return new Request(`http://localhost:3100${pathname}`, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      cookie: `fdb_session=${SESSION_TOKEN}`,
    },
  });
}

function allGreenChecks(atUtc: string): readonly HealthCheck[] {
  return (["feed", "queue", "api", "db", "cache", "risk"] as const).map(
    (component) => ({
      component,
      status: "ok" as const,
      observedAtUtc: atUtc,
      reason: null,
      metrics: {},
    }),
  );
}

describe("durableHealthEvidence", () => {
  it("fails closed on absent data and reports real zero backlog", () => {
    const evidence = durableHealthEvidence(runtime.database as DatabaseSync, {
      artifactRoot: mkdtempSync(path.join(tmpdir(), "fdb-health-artifacts-")),
      observedAtUtc: "2026-09-29T16:00:00.000Z",
      diskFreeBytes: () => 1024 * 1024 * 1024,
    });
    expect(evidence.checks.find((check) => check.component === "feed")).toMatchObject({ status: "down", reason: "feed_no_data" });
    expect(evidence.checks.find((check) => check.component === "queue")?.metrics).toMatchObject({ backlog: 0, running: 0 });
  });

  it("projects durable queue backlog and corrupt artifact evidence", () => {
    const db = runtime.database as DatabaseSync;
    db.prepare(`INSERT INTO market_data_ingestion_jobs (job_id,dedup_key,request_hash,status,attempts,dataset_id,failure_reason,created_at_utc,updated_at_utc) VALUES ('job-health','dedup-health',?,'pending',0,NULL,NULL,?,?)`).run("a".repeat(64), "2026-09-29T15:00:00.000Z", "2026-09-29T15:00:00.000Z");
    db.prepare(`INSERT INTO market_data_artifacts (digest,relative_path,byte_count,media_type,created_at_utc) VALUES (?, 'missing.candles', 1, 'application/vnd.fdbtrade.candles', ?)` ).run("b".repeat(64), "2026-09-29T15:00:00.000Z");
    const root = mkdtempSync(path.join(tmpdir(), "fdb-health-corrupt-")); roots.push(root);
    const evidence = durableHealthEvidence(db, { artifactRoot: root, observedAtUtc: "2026-09-29T16:00:00.000Z", diskFreeBytes: () => 1024 * 1024 * 1024 });
    expect(evidence.checks.find((check) => check.component === "queue")).toMatchObject({ status: "degraded", reason: "queue_backlog" });
    expect(evidence.checks.find((check) => check.component === "cache")).toMatchObject({ status: "down", reason: "cache_unreachable" });
  });

  it("degrades on measured low disk budget", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fdb-health-disk-")); roots.push(root);
    const evidence = durableHealthEvidence(runtime.database as DatabaseSync, { artifactRoot: root, observedAtUtc: "2026-09-29T16:00:00.000Z", diskFreeBytes: () => 1, minimumFreeBytes: 2 });
    expect(evidence.checks.find((check) => check.component === "cache")).toMatchObject({ status: "degraded", reason: "cache_stale" });
  });
});

describe("currentHealthSnapshot (default factory)", () => {
  it("fixture feed is explicitly degraded, never fabricated green", async () => {
    const snapshot = await currentHealthSnapshot(undefined, () => "green");
    const feed = snapshot.checks.find((check) => check.component === "feed");
    expect(feed?.effectiveStatus).not.toBe("ok");
    expect(feed?.reason).toBe("feed_no_data");
    expect(["degraded", "fail_safe"]).toContain(snapshot.state);
  });

  it("db down drives fail_safe with denyNewEntries", async () => {
    const { checkDatabaseHealth } = await import("@/db/client");
    vi.mocked(checkDatabaseHealth).mockResolvedValueOnce({
      status: "unavailable",
      latencyMs: 2001,
      errorCode: "ETIMEDOUT",
    });
    const snapshot = await currentHealthSnapshot(undefined, () => "green");
    expect(snapshot.state).toBe("fail_safe");
    expect(snapshot.failSafe.denyNewEntries).toBe(true);
    expect(snapshot.reasons).toContain("db_unreachable");
  });

  it("proves green -> kill -> reopen -> kill -> release -> red from a file-backed database", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "fdb-health-r011-"));
    roots.push(root);
    const databasePath = path.join(root, "fdbtrade.sqlite3");
    let database = openMigratedDatabase(databasePath);
    const market = new MarketDataAuthority(database, path.join(root, "artifacts", "market-data"));
    let authority = new RiskPaperAuthority(database, market);
    authority.registerBaseline("2026-09-23T00:00:00.000Z");
    const baseTime = Date.now();
    const checks = async () => allGreenChecks(new Date(baseTime).toISOString());

    expect((await currentHealthSnapshot(checks, () => durableRiskState(database))).state).toBe("healthy");
    authority.engageKill("owner", "durable incident halt", new Date(baseTime + 1).toISOString());
    expect((await currentHealthSnapshot(checks, () => durableRiskState(database))).state).toBe("fail_safe");

    database.close();
    database = openDatabase({ databasePath, mustExist: true });
    const reopenedMarket = new MarketDataAuthority(database, path.join(root, "artifacts", "market-data"));
    authority = new RiskPaperAuthority(database, reopenedMarket);
    expect(durableRiskState(database)).toBe("kill");
    expect((await currentHealthSnapshot(checks, () => durableRiskState(database))).state).toBe("fail_safe");

    authority.releaseKill("owner", "incident reviewed", new Date(baseTime + 2).toISOString());
    expect(durableRiskState(database)).toBe("red");
    expect((await currentHealthSnapshot(checks, () => durableRiskState(database))).state).toBe("fail_safe");
    database.close();
  });
});

describe("GET /api/admin/health", () => {
  it("returns the snapshot with state, failSafe and checks", async () => {
    const response = await getHealth(request("/api/admin/health"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { state: string; failSafe: { denyNewEntries: boolean; description: string }; checks: unknown[]; reasons: string[] };
    };
    expect(body.ok).toBe(true);
    expect(["degraded", "fail_safe"]).toContain(body.data.state);
    expect(typeof body.data.failSafe.description).toBe("string");
    expect(Array.isArray(body.data.checks)).toBe(true);
    expect(Array.isArray(body.data.reasons)).toBe(true);
  });

  it("missing session -> 401", async () => {
    const response = await getHealth(new Request("http://localhost:3100/api/admin/health"));
    expect(response.status).toBe(401);
  });

  it("POST -> 405", async () => {
    const response = await postHealth(request("/api/admin/health", { method: "POST" }));
    expect(response.status).toBe(405);
  });
});
