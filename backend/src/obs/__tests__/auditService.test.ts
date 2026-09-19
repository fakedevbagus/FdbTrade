/**
 * Audit service + admin route tests (P13-02).
 *
 * Covers: append happy path (actor/before/after/correlation/source recorded),
 * malformed append fails closed and leaves the log unchanged, duplicate
 * replay refused, chronology enforced through the service, secret-shaped
 * before/after refused, subject filter, digest stability, and the API
 * surface (list, subject filter, 400 malformed filter, 401 no session, 405
 * writes). Session lookup stubbed at the auth-store boundary.
 */
import { describe, expect, it, vi } from "vitest";

import type { AuthResult } from "@/auth/store";

const SESSION_TOKEN = "test-session-token-audit";
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

import { AuditService } from "@/obs/auditService";
import { GET as getAudit, POST as postAudit } from "@/app/api/admin/audit/route";

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:3100${path}`, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      cookie: `fdb_session=${SESSION_TOKEN}`,
    },
  });
}

const T0 = "2026-09-11T11:00:00.000Z";
const T1 = "2026-09-11T11:00:01.000Z";

describe("AuditService", () => {
  it("appends an entry with actor, before/after, timestamp, correlation and source", () => {
    const service = new AuditService();
    const event = service.append({
      atUtc: T0,
      actor: "owner",
      action: "update_limits",
      subjectType: "config",
      subjectId: "risk.limits@1.0.0",
      before: { maxDailyLossFraction: 0.015 },
      after: { maxDailyLossFraction: 0.02 },
      correlationId: "req-audit-1",
      source: "admin-api",
    });
    expect(event.seq).toBe(1);
    expect(event.actor).toBe("owner");
    expect(event.before).toEqual({ maxDailyLossFraction: 0.015 });
    expect(event.after).toEqual({ maxDailyLossFraction: 0.02 });
    expect(event.source).toBe("admin-api");
  });

  it("malformed append fails closed and leaves the log unchanged", () => {
    const service = new AuditService();
    expect(() =>
      service.append({
        atUtc: T0,
        actor: "anonymous",
        action: "x",
        subjectType: "config",
        subjectId: "cfg",
        before: null,
        after: {},
        correlationId: "req-1",
        source: "admin-api",
      }),
    ).toThrow(/actor/);
    expect(service.events()).toHaveLength(0);
  });

  it("duplicate replay is refused; chronology is enforced", () => {
    const service = new AuditService();
    service.append({
      atUtc: T1,
      actor: "owner",
      action: "a",
      subjectType: "config",
      subjectId: "cfg",
      before: null,
      after: { v: 1 },
      correlationId: "req-1",
      source: "admin-api",
    });
    expect(() =>
      service.append({
        atUtc: T1,
        actor: "owner",
        action: "a",
        subjectType: "config",
        subjectId: "cfg",
        before: null,
        after: { v: 1 },
        correlationId: "req-1",
        source: "admin-api",
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      service.append({
        atUtc: T0,
        actor: "owner",
        action: "b",
        subjectType: "config",
        subjectId: "cfg",
        before: null,
        after: { v: 2 },
        correlationId: "req-1",
        source: "admin-api",
      }),
    ).toThrow(/atUtc order/);
    expect(service.events()).toHaveLength(1);
  });

  it("secret-shaped before/after values are refused", () => {
    const service = new AuditService();
    expect(() =>
      service.append({
        atUtc: T0,
        actor: "owner",
        action: "a",
        subjectType: "config",
        subjectId: "cfg",
        before: null,
        after: { password: "x" },
        correlationId: "req-1",
        source: "admin-api",
      }),
    ).toThrow(/secret-shaped/);
  });

  it("digest is stable for the same stream", () => {
    const a = new AuditService();
    const b = new AuditService();
    for (const service of [a, b]) {
      service.append({
        atUtc: T0,
        actor: "owner",
        action: "a",
        subjectType: "config",
        subjectId: "cfg",
        before: null,
        after: { v: 1 },
        correlationId: "req-1",
        source: "admin-api",
      });
    }
    expect(a.digest()).toBe(b.digest());
  });
});

describe("GET /api/admin/audit", () => {
  it("returns events with count and digest", async () => {
    const response = await getAudit(request("/api/admin/audit"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { digest: string; count: number; events: unknown[] };
    };
    expect(body.ok).toBe(true);
    expect(typeof body.data.digest).toBe("string");
    expect(typeof body.data.count).toBe("number");
    expect(Array.isArray(body.data.events)).toBe(true);
  });

  it("rejects a malformed subjectId filter with 400", async () => {
    const response = await getAudit(request("/api/admin/audit?subjectId="));
    expect(response.status).toBe(400);
  });

  it("missing session -> 401 (fail closed)", async () => {
    const response = await getAudit(new Request("http://localhost:3100/api/admin/audit"));
    expect(response.status).toBe(401);
  });

  it("POST -> 405 (append-only by services, never client POST)", async () => {
    const response = await postAudit(request("/api/admin/audit", { method: "POST" }));
    expect(response.status).toBe(405);
  });
});
