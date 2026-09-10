/**
 * `/api/signals/[id]` route tests (P07-03).
 *
 * Covers: happy path (existing decision -> full detail), unknown id -> 404,
 * malformed id -> 404, missing asOfUtc -> 400, missing session -> 401, and
 * 405 for writes. Session lookup stubbed at the auth-store boundary.
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

import { GET, POST } from "@/app/api/signals/[id]/route";
import { buildDashboardSnapshot, PIPELINE_TIMEFRAME } from "@/signals/pipeline";

const MIDWEEK = "2026-09-09T10:00:00.000Z";

async function existingDecisionId(): Promise<string> {
  const snap = await buildDashboardSnapshot({
    asOfUtc: MIDWEEK,
    instruments: ["EURUSD"],
  });
  const row = snap.overview[0];
  return `ens_${row.instrument}_${PIPELINE_TIMEFRAME}_${row.eventTimeUtc}`;
}

function request(path: string): Request {
  return new Request(`http://localhost:3100${path}`, {
    headers: { cookie: `fdb_session=${SESSION_TOKEN}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/signals/[id]", () => {
  it("happy path: existing decision -> full detail envelope", async () => {
    const id = await existingDecisionId();
    const response = await GET(
      request(`/api/signals/${encodeURIComponent(id)}?asOfUtc=${MIDWEEK}`),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { found: boolean; decision: { decisionId: string }; votes: unknown[] };
    };
    expect(body.ok).toBe(true);
    expect(body.data.found).toBe(true);
    expect(body.data.decision.decisionId).toBe(id);
    expect(body.data.votes.length).toBeGreaterThan(0);
  });

  it("unknown decisionId -> 404", async () => {
    const id = "ens_EURUSD_1h_1999-01-01T00:00:00.000Z";
    const response = await GET(
      request(`/api/signals/${id}?asOfUtc=${MIDWEEK}`),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(404);
  });

  it("malformed decisionId -> 404 (never improvised)", async () => {
    const id = "not-a-decision-id";
    const response = await GET(
      request(`/api/signals/${id}?asOfUtc=${MIDWEEK}`),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(404);
  });

  it("missing asOfUtc -> 400", async () => {
    const id = "ens_EURUSD_1h_2026-09-09T09:00:00.000Z";
    const response = await GET(request(`/api/signals/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(response.status).toBe(400);
  });

  it("missing session -> 401 (fail closed)", async () => {
    const id = "ens_EURUSD_1h_2026-09-09T09:00:00.000Z";
    const response = await GET(
      new Request(`http://localhost:3100/api/signals/${id}?asOfUtc=${MIDWEEK}`),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(401);
  });

  it("POST rejected with 405 + allow header", async () => {
    const id = "ens_EURUSD_1h_2026-09-09T09:00:00.000Z";
    const response = await POST(request(`/api/signals/${id}`));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });
});
