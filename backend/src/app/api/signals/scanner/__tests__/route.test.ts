/**
 * `/api/signals/scanner` route tests (P07-02).
 *
 * Covers: happy path (valid session + filters -> filtered rows + canonical
 * params echo), missing session -> 401, malformed/duplicate/unknown query
 * -> 400, misaligned asOfUtc -> 400, and 405 for writes. Session lookup is
 * stubbed at the auth-store boundary.
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

import { GET, POST } from "@/app/api/signals/scanner/route";

const MIDWEEK = "2026-09-09T10:00:00.000Z";

function request(path: string): Request {
  return new Request(`http://localhost:3100${path}`, {
    headers: { cookie: `fdb_session=${SESSION_TOKEN}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/signals/scanner", () => {
  it("happy path: returns filtered rows with canonical params echo", async () => {
    const response = await GET(
      request(`/api/signals/scanner?asOfUtc=${MIDWEEK}&direction=long&sort=edge`),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: {
        asOfUtc: string;
        query: { direction: string; sort: string };
        canonicalParams: string;
        rows: { action: string }[];
        totalRows: number;
        errors: unknown[];
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.asOfUtc).toBe(MIDWEEK);
    expect(body.data.query.direction).toBe("long");
    expect(body.data.query.sort).toBe("edge");
    expect(body.data.canonicalParams).toBe("direction=long&sort=edge");
    expect(body.data.rows.every((r) => r.action === "enter_long")).toBe(true);
    expect(body.data.totalRows).toBeGreaterThanOrEqual(body.data.rows.length);
  });

  it("happy path: default query echoes empty canonical params", async () => {
    const response = await GET(request(`/api/signals/scanner?asOfUtc=${MIDWEEK}`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { canonicalParams: string } };
    expect(body.data.canonicalParams).toBe("");
  });

  it("missing session -> 401 (fail closed)", async () => {
    const response = await GET(
      new Request(`http://localhost:3100/api/signals/scanner?asOfUtc=${MIDWEEK}`, {
        headers: { cookie: "fdb_session=nope" },
      }),
    );
    expect(response.status).toBe(401);
  });

  it("missing asOfUtc -> 400", async () => {
    const response = await GET(request("/api/signals/scanner"));
    expect(response.status).toBe(400);
  });

  it("malformed direction -> 400", async () => {
    const response = await GET(
      request(`/api/signals/scanner?asOfUtc=${MIDWEEK}&direction=buy`),
    );
    expect(response.status).toBe(400);
  });

  it("misaligned asOfUtc -> 400 (fail closed)", async () => {
    const response = await GET(
      request(`/api/signals/scanner?asOfUtc=2026-09-09T10:30:00.000Z`),
    );
    expect(response.status).toBe(400);
  });

  it("duplicate query param -> 400", async () => {
    const response = await GET(
      request(`/api/signals/scanner?asOfUtc=${MIDWEEK}&sort=rank&sort=edge`),
    );
    expect(response.status).toBe(400);
  });

  it("unknown query param -> 400 (strict)", async () => {
    const response = await GET(
      request(`/api/signals/scanner?asOfUtc=${MIDWEEK}&hax=1`),
    );
    expect(response.status).toBe(400);
  });

  it("POST rejected with 405 + allow header", async () => {
    const response = await POST(request("/api/signals/scanner"));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });
});
