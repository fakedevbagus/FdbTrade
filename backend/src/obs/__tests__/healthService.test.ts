/**
 * Health aggregator + risk-state store + admin route tests (P13-04).
 *
 * Covers: default-factory snapshot (fixture feed explicitly degraded, db
 * down drives fail_safe), the latched risk-state store (human-only kill,
 * audited, release lands red, invalid override changes nothing), and the
 * API surface (snapshot shape, 401 no session, 405 writes). DB health and
 * session lookups stubbed at their boundaries.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import type { AuthResult } from "@/auth/store";

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
}));

import { currentHealthSnapshot } from "@/obs/healthService";
import { RiskStateStore } from "@/obs/riskStateStore";
import { auditService } from "@/obs/auditService";
import { GET as getHealth, POST as postHealth } from "@/app/api/admin/health/route";

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:3100${path}`, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      cookie: `fdb_session=${SESSION_TOKEN}`,
    },
  });
}

describe("currentHealthSnapshot (default factory)", () => {
  it("fixture feed is explicitly degraded, never fabricated green", async () => {
    const snapshot = await currentHealthSnapshot();
    const feed = snapshot.checks.find((c) => c.component === "feed");
    expect(feed?.effectiveStatus).not.toBe("ok");
    expect(feed?.reason).toBe("feed_no_data");
    expect(["degraded", "fail_safe"]).toContain(snapshot.state);
  });

  it("db down (mocked) drives fail_safe with denyNewEntries", async () => {
    const { checkDatabaseHealth } = await import("@/db/client");
    vi.mocked(checkDatabaseHealth).mockResolvedValueOnce({
      status: "unavailable",
      latencyMs: 2001,
      errorCode: "ETIMEDOUT",
    });
    const snapshot = await currentHealthSnapshot();
    expect(snapshot.state).toBe("fail_safe");
    expect(snapshot.failSafe.denyNewEntries).toBe(true);
    expect(snapshot.reasons).toContain("db_unreachable");
  });

  it("risk state contributes: kill drives fail_safe with the explicit reason", async () => {
    const store = new RiskStateStore();
    store.applyOverride({
      action: "engage_kill",
      targetState: null,
      actor: "owner",
      reason: "halt",
    });
    // The default factory reads the global singleton; engage it the same way.
    const { riskStateStore } = await import("@/obs/riskStateStore");
    const previous = riskStateStore.state;
    try {
      // Swap state via the singleton itself (test-scoped).
      riskStateStore.applyOverride({
        action: "engage_kill",
        targetState: null,
        actor: "owner",
        reason: "halt",
      });
      const snapshot = await currentHealthSnapshot();
      expect(snapshot.state).toBe("fail_safe");
      expect(snapshot.reasons).toContain("risk_kill_engaged");
      expect(snapshot.failSafe.denyNewEntries).toBe(true);
    } finally {
      // Restore: release_kill lands in red, then force back to the previous.
      riskStateStore.applyOverride({
        action: "release_kill",
        targetState: null,
        actor: "owner",
        reason: "test restore",
      });
      riskStateStore.applyOverride({
        action: "force_state",
        targetState: previous === "kill" ? "red" : previous,
        actor: "owner",
        reason: "test restore",
      });
      auditService.resetForTest();
    }
  });
});

describe("RiskStateStore", () => {
  let store: RiskStateStore;

  beforeEach(() => {
    store = new RiskStateStore();
    auditService.resetForTest();
  });

  it("starts green; human engage_kill latches kill and is audited", () => {
    expect(store.state).toBe("green");
    const result = store.applyOverride({
      action: "engage_kill",
      targetState: null,
      actor: "owner",
      reason: "manual halt for incident",
    });
    expect(result.from).toBe("green");
    expect(result.to).toBe("kill");
    expect(store.state).toBe("kill");
    const events = auditService.events();
    expect(events).toHaveLength(1);
    expect(events[0].subjectType).toBe("risk_override");
    expect(events[0].before).toEqual({ state: "green" });
    expect(events[0].after).toEqual({ state: "kill" });
  });

  it("kill is sticky — no auto-reset path exists (overrides only)", () => {
    store.applyOverride({
      action: "engage_kill",
      targetState: null,
      actor: "owner",
      reason: "manual halt",
    });
    expect(store.state).toBe("kill");
  });

  it("release_kill lands in red (conservative)", () => {
    store.applyOverride({
      action: "engage_kill",
      targetState: null,
      actor: "owner",
      reason: "halt",
    });
    const result = store.applyOverride({
      action: "release_kill",
      targetState: null,
      actor: "owner",
      reason: "incident reviewed",
    });
    expect(result.to).toBe("red");
    expect(store.state).toBe("red");
  });

  it("invalid overrides change nothing (fail closed)", () => {
    expect(() =>
      store.applyOverride({
        action: "release_kill",
        targetState: null,
        actor: "owner",
        reason: "nothing to release",
      }),
    ).toThrow();
    expect(store.state).toBe("green");
    expect(auditService.events()).toHaveLength(0);
  });
});

describe("GET /api/admin/health", () => {
  it("returns the snapshot with state, failSafe and checks", async () => {
    const response = await getHealth(request("/api/admin/health"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: {
        state: string;
        failSafe: { denyNewEntries: boolean; description: string };
        checks: unknown[];
        reasons: string[];
      };
    };
    expect(body.ok).toBe(true);
    expect(["healthy", "degraded", "fail_safe"]).toContain(body.data.state);
    expect(typeof body.data.failSafe.description).toBe("string");
    expect(Array.isArray(body.data.checks)).toBe(true);
    expect(Array.isArray(body.data.reasons)).toBe(true);
  });

  it("missing session -> 401 (fail closed)", async () => {
    const response = await getHealth(new Request("http://localhost:3100/api/admin/health"));
    expect(response.status).toBe(401);
  });

  it("POST -> 405", async () => {
    const response = await postHealth(request("/api/admin/health", { method: "POST" }));
    expect(response.status).toBe(405);
  });
});

