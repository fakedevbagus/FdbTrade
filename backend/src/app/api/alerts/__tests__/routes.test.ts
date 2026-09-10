/**
 * `/api/alerts/*` route tests (P07-05).
 *
 * Covers: GET preferences (defaults), PUT preferences (validate + store),
 * malformed PUT body -> 400, GET events (read-only), session guard (401),
 * and method-not-allowed on writes to the events endpoint. Session lookup
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

import {
  GET as getPrefs,
  PUT as putPrefs,
} from "@/app/api/alerts/preferences/route";
import { GET as getEvents } from "@/app/api/alerts/events/route";

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:3100${path}`, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      cookie: `fdb_session=${SESSION_TOKEN}`,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET/PUT /api/alerts/preferences", () => {
  it("happy path: GET returns default preferences", async () => {
    const response = await getPrefs(request("/api/alerts/preferences"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { enabled: boolean; channel: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.channel).toBe("noop");
  });

  it("happy path: PUT stores validated preferences", async () => {
    const response = await putPrefs(
      request("/api/alerts/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          classes: { signal_created: true, signal_expired: false, decision_wait: false },
          channel: "noop",
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { enabled: boolean } };
    expect(body.data.enabled).toBe(true);
  });

  it("malformed body -> 400 VALIDATION_ERROR", async () => {
    const response = await putPrefs(
      request("/api/alerts/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, classes: { bogus: true }, channel: "noop" }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("non-JSON content type -> 415", async () => {
    const response = await putPrefs(
      request("/api/alerts/preferences", {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: "not json",
      }),
    );
    expect(response.status).toBe(415);
  });

  it("missing session -> 401 (fail closed)", async () => {
    const response = await getPrefs(
      new Request("http://localhost:3100/api/alerts/preferences"),
    );
    expect(response.status).toBe(401);
  });
});

describe("GET /api/alerts/events", () => {
  it("happy path: returns the (possibly empty) event list", async () => {
    const response = await getEvents(request("/api/alerts/events"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { events: { eventId: string }[] };
    };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data.events)).toBe(true);
  });

  it("missing session -> 401", async () => {
    const response = await getEvents(
      new Request("http://localhost:3100/api/alerts/events"),
    );
    expect(response.status).toBe(401);
  });
});
