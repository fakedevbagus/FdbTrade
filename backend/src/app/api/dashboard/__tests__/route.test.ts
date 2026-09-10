/**
 * `/api/dashboard` route tests (P07-01).
 *
 * Covers: happy path (valid session + query -> snapshot envelope), missing
 * session -> 401, malformed query (missing/misaligned/non-UTC asOfUtc) ->
 * 400 VALIDATION_ERROR, unknown extra query params rejected (strict), and
 * method-not-allowed for writes.
 *
 * Session store + database are not touched: requireSession's cookie path is
 * exercised through a stubbed module boundary (session lookup injected via
 * vi.mock on the auth store).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthResult } from "@/auth/store";

const SESSION_TOKEN = "test-session-token-123";
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

import { GET, POST } from "@/app/api/dashboard/route";

const MIDWEEK = "2026-09-09T10:00:00.000Z";

function request(path: string): Request {
  return new Request(`http://localhost:3100${path}`, {
    headers: { cookie: `fdb_session=${SESSION_TOKEN}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/dashboard", () => {
  it("happy path: returns the deterministic snapshot envelope", async () => {
    const response = await GET(request(`/api/dashboard?asOfUtc=${MIDWEEK}`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { asOfUtc: string; overview: unknown[]; generatedFrom: string };
      requestId: string;
      timestamp: string;
    };
    expect(body.ok).toBe(true);
    expect(body.data.asOfUtc).toBe(MIDWEEK);
    expect(body.data.generatedFrom).toBe("fixture");
    expect(Array.isArray(body.data.overview)).toBe(true);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.timestamp).toMatch(/Z$/);
  });

  it("missing session -> 401 (fail closed)", async () => {
    const response = await GET(
      new Request(`http://localhost:3100/api/dashboard?asOfUtc=${MIDWEEK}`, {
        headers: { cookie: "fdb_session=unknown-token" },
      }),
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("missing asOfUtc -> 400 VALIDATION_ERROR", async () => {
    const response = await GET(request("/api/dashboard"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("misaligned asOfUtc -> 400 (fail closed)", async () => {
    const response = await GET(
      request("/api/dashboard?asOfUtc=2026-09-09T10:30:00.000Z"),
    );
    expect(response.status).toBe(400);
  });

  it("non-UTC instant -> 400", async () => {
    const response = await GET(
      request("/api/dashboard?asOfUtc=2026-09-09T10:00:00.000%2B02:00"),
    );
    expect(response.status).toBe(400);
  });

  it("unknown query param rejected (strict schema)", async () => {
    const response = await GET(
      request(`/api/dashboard?asOfUtc=${MIDWEEK}&extra=1`),
    );
    expect(response.status).toBe(400);
  });

  it("POST rejected with 405 + allow header", async () => {
    const response = await POST(request("/api/dashboard"));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("no cookie at all -> 401", async () => {
    const response = await GET(
      new Request(`http://localhost:3100/api/dashboard?asOfUtc=${MIDWEEK}`),
    );
    expect(response.status).toBe(401);
  });
});
