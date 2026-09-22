/**
 * Unit tests for the health and catch-all routes (P01-02/P01-03).
 *
 * Handlers are invoked directly (the live-server smoke test lives in
 * `tests/test_api_foundation_contracts.py`, the live database integration in
 * `tests/test_db_foundation_contracts.py`). The database health check is
 * mocked here so the route contract is deterministic without a database.
 */
import { describe, expect, it, vi } from "vitest";

import { GET as healthGet, POST as healthPost } from "@/app/api/health/route";
import { GET as catchAllGet } from "@/app/api/[...slug]/route";

vi.mock("@/db/client", () => ({
  checkDatabaseHealth: vi.fn(async () => ({
    status: "unavailable",
    latencyMs: 1,
    errorCode: "ECONNREFUSED",
  })),
}));

describe("GET /api/health", () => {
  it("reports degraded state and database check in the success envelope", async () => {
    const response = await healthGet(new Request("http://localhost/api/health"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as {
      ok: boolean;
      data: {
        status: string;
        service: string;
        environment: string;
        uptimeSeconds: number;
        serverTimeUtc: string;
        checks: { process: string; database: string };
      };
      requestId: string;
      timestamp: string;
    };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("degraded"); // mocked DB unavailable
    expect(body.data.service).toBe("fdbtrade-api");
    expect(body.data.environment).toBe("testing");
    expect(typeof body.data.uptimeSeconds).toBe("number");
    expect(body.data.serverTimeUtc).toMatch(/Z$/u);
    expect(body.data.checks.process).toBe("ok");
    expect(body.data.checks.database).toBe("unavailable");
    expect(body.requestId).toBe(response.headers.get("x-request-id"));
    expect(body.timestamp).toMatch(/Z$/u);
  });

  it("never includes database error details in the response", async () => {
    const response = await healthGet(new Request("http://localhost/api/health"));
    const text = await response.text();
    expect(text).not.toContain("ECONNREFUSED");
    expect(text).not.toContain("password");
  });

  it("reuses the incoming request id for traceability", async () => {
    const response = await healthGet(
      new Request("http://localhost/api/health", {
        headers: { "x-request-id": "req-health-1" },
      }),
    );
    expect(response.headers.get("x-request-id")).toBe("req-health-1");
  });
});

describe("POST /api/health (method guard)", () => {
  it("returns a structured 405 with allow: GET", async () => {
    const response = await healthPost(
      new Request("http://localhost/api/health", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    const body = (await response.json()) as {
      ok: boolean;
      error: { code: string };
      requestId: string;
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("METHOD_NOT_ALLOWED");
    expect(body.requestId).toBeTruthy();
  });
});

describe("catch-all /api/* handler", () => {
  it("returns a structured NOT_FOUND with a request id", async () => {
    const response = await catchAllGet(
      new Request("http://localhost/api/does-not-exist"),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      ok: boolean;
      error: { code: string };
      requestId: string;
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.requestId).toBeTruthy();
  });
});
