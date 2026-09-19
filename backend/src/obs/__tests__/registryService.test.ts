/**
 * Registry service + admin route tests (P13-03).
 *
 * Covers: register happy path (audit event appended with subject provenance),
 * idempotent re-registration (no duplicate audit), same-artifact different
 * content refused, malformed entry refused leaving registry unchanged, and
 * the API surface (list + champions, 401 no session, 405 writes). Session
 * lookup stubbed at the auth-store boundary.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthResult } from "@/auth/store";
import type { RegistryEntryInput } from "@fdbtrade/contracts";

const SESSION_TOKEN = "test-session-token-registry";
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

import { RegistryService } from "@/obs/registryService";
import { auditService } from "@/obs/auditService";
import { GET as getRegistry, POST as postRegistry } from "@/app/api/admin/registry/route";



function request(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:3100${path}`, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      cookie: `fdb_session=${SESSION_TOKEN}`,
    },
  });
}

const T0 = "2026-09-11T12:00:00.000Z";
const SHA64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function entryInput(overrides: Partial<RegistryEntryInput> = {}): RegistryEntryInput {
  return {
    kind: "strategy",
    artifactId: "trend-pullback@1.2.0",
    configHash: SHA64,
    dataset: { datasetId: "ds-eurusd-1h-2026", digest: SHA64 },
    modelMetadata: null,
    state: "candidate",
    researchRunIds: ["run-alpha-1"],
    limitations: "Trend-following only; no range-regime edge.",
    registeredAtUtc: T0,
    registeredBy: "owner",
    ...overrides,
  };
}

describe("RegistryService", () => {
  let service: RegistryService;

  beforeEach(() => {
    service = new RegistryService();
    auditService.resetForTest();
  });

  it("registers a new entry and appends a strategy_version audit event", () => {
    const entry = service.register(entryInput());
    expect(entry.artifactId).toBe("trend-pullback@1.2.0");
    const events = auditService.events();
    expect(events).toHaveLength(1);
    expect(events[0].subjectType).toBe("strategy_version");
    expect(events[0].subjectId).toBe("trend-pullback@1.2.0");
    expect(events[0].after).toEqual({
      kind: "strategy",
      state: "candidate",
      datasetId: "ds-eurusd-1h-2026",
    });
  });

  it("idempotent re-registration appends no second audit event", () => {
    service.register(entryInput());
    service.register(entryInput());
    expect(service.entries()).toHaveLength(1);
    expect(auditService.events()).toHaveLength(1);
  });

  it("same artifact with different content is refused", () => {
    service.register(entryInput());
    expect(() =>
      service.register(
        entryInput({ limitations: "Completely different limitation text for same version." }),
      ),
    ).toThrow(/already registered/);
    expect(service.entries()).toHaveLength(1);
  });

  it("malformed entry is refused and the registry stays unchanged", () => {
    expect(() => service.register(entryInput({ limitations: "short" }))).toThrow();
    expect(() => service.register(entryInput({ configHash: "nope" }))).toThrow();
    expect(service.entries()).toHaveLength(0);
  });
});

describe("GET /api/admin/registry", () => {
  it("returns entries with count and champion list", async () => {
    const response = await getRegistry(request("/api/admin/registry"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { count: number; champions: string[]; entries: { artifactId: string }[] };
    };
    expect(body.ok).toBe(true);
    expect(typeof body.data.count).toBe("number");
    expect(Array.isArray(body.data.champions)).toBe(true);
    expect(Array.isArray(body.data.entries)).toBe(true);
  });

  it("missing session -> 401 (fail closed)", async () => {
    const response = await getRegistry(new Request("http://localhost:3100/api/admin/registry"));
    expect(response.status).toBe(401);
  });

  it("POST -> 405 (no client promotion/registration)", async () => {
    const response = await postRegistry(request("/api/admin/registry", { method: "POST" }));
    expect(response.status).toBe(405);
  });
});
