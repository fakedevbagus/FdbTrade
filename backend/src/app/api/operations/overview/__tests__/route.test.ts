/** R0.11 route behavior for read-only operations and durable controls. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthResult } from "@/auth/store";

const SESSION_TOKEN = "test-session-token-operations";
const AUTH_RESULT: AuthResult = {
  session: {
    id: "sess-operations",
    userId: "user-operations",
    createdAt: "2026-09-23T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
  user: { id: "user-operations", username: "owner", isActive: true, mfaEnabled: false },
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
  getDatabase: vi.fn(() => {
    if (!runtime.database) throw new Error("test database is not initialized");
    return runtime.database;
  }),
}));

import {
  GET as getControls,
  POST as postControls,
} from "@/app/api/admin/controls/route";
import {
  GET as getOverview,
  POST as postOverview,
} from "@/app/api/operations/overview/route";
import { MarketDataAuthority } from "@/data/marketAuthority";
import { openMigratedDatabase } from "@/db/sqlite.mjs";
import { RiskPaperAuthority } from "@/paper/riskPaperAuthority";

let root: string;

function request(pathname: string, init?: RequestInit): Request {
  return new Request(`http://localhost:3100${pathname}`, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      cookie: `fdb_session=${SESSION_TOKEN}`,
      "content-type": "application/json",
    },
  });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "fdb-r011-routes-"));
  runtime.database = openMigratedDatabase(path.join(root, "fdbtrade.sqlite3"));
  const authority = new RiskPaperAuthority(
    runtime.database,
    new MarketDataAuthority(runtime.database, path.join(root, "artifacts", "market-data")),
  );
  authority.registerBaseline("2026-09-23T00:00:00.000Z");
});

afterEach(() => {
  runtime.database?.close();
  runtime.database = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("operations overview route", () => {
  it("projects SQLite authority and denies mutation", async () => {
    const response = await getOverview(request("/api/operations/overview"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { authority: string; risk: { state: string }; safety: Record<string, boolean | string> };
    };
    expect(body.data.authority).toBe("sqlite");
    expect(body.data.risk.state).toBe("green");
    expect(body.data.safety).toMatchObject({
      liveExecutionEnabled: false,
      providerOrderTransportEnabled: false,
      credentialedProviderSelected: false,
      modelPromotionAuthority: false,
      uiAuthority: false,
    });
    expect((await postOverview(request("/api/operations/overview", { method: "POST" }))).status).toBe(405);
  });

  it("fails closed without a session", async () => {
    const response = await getOverview(new Request("http://localhost:3100/api/operations/overview"));
    expect(response.status).toBe(401);
  });
});

describe("durable controls route", () => {
  it("persists kill and releases only to red for the overview projection", async () => {
    const initial = await getControls(request("/api/admin/controls"));
    expect(initial.status).toBe(200);
    expect(((await initial.json()) as { data: { riskState: string } }).data.riskState).toBe("green");

    const kill = await postControls(request("/api/admin/controls", {
      method: "POST",
      body: JSON.stringify({ action: "engage_kill", reason: "route behavior incident" }),
    }));
    expect(kill.status).toBe(200);
    expect(((await kill.json()) as { data: { state: string } }).data.state).toBe("kill");
    const killedOverview = await getOverview(request("/api/operations/overview"));
    expect(((await killedOverview.json()) as { data: { risk: { state: string } } }).data.risk.state).toBe("kill");

    const release = await postControls(request("/api/admin/controls", {
      method: "POST",
      body: JSON.stringify({ action: "release_kill", reason: "route incident reviewed" }),
    }));
    expect(release.status).toBe(200);
    expect(((await release.json()) as { data: { state: string } }).data.state).toBe("red");
    const releasedOverview = await getOverview(request("/api/operations/overview"));
    expect(((await releasedOverview.json()) as { data: { risk: { state: string } } }).data.risk.state).toBe("red");
  });

  it("rejects malformed, unknown and unauthenticated mutations without a durable change", async () => {
    const malformed = await postControls(request("/api/admin/controls", {
      method: "POST",
      body: JSON.stringify({ action: "engage_kill" }),
    }));
    expect(malformed.status).toBe(400);
    const unknown = await postControls(request("/api/admin/controls", {
      method: "POST",
      body: JSON.stringify({ action: "enable_live", reason: "forbidden" }),
    }));
    expect(unknown.status).toBe(400);
    const unauthenticated = await postControls(new Request("http://localhost:3100/api/admin/controls", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "engage_kill", reason: "no session" }),
    }));
    expect(unauthenticated.status).toBe(401);
    expect(Number(runtime.database?.prepare("SELECT COUNT(*) AS count FROM risk_state_events").get()?.count)).toBe(1);
  });
});
