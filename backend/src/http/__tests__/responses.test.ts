/**
 * Unit tests for structured response envelopes (P01-02).
 *
 * Covers: happy-path success body, error body (with and without details),
 * response headers (content type, no-store, request id), and the UTC
 * timestamp invariant (ADR-0004).
 */
import { describe, expect, it } from "vitest";

import { UTC_ISO_PATTERN, jsonError, jsonOk } from "@/http/responses";

describe("jsonOk", () => {
  it("wraps data in the success envelope with traceability", async () => {
    const response = jsonOk({ hello: "world" }, { requestId: "req-1" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBe("req-1");

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      data: { hello: "world" },
      requestId: "req-1",
    });
    expect(body.timestamp).toMatch(UTC_ISO_PATTERN);
  });

  it("honors an explicit status", () => {
    const response = jsonOk({ created: true }, { requestId: "r", status: 201 });
    expect(response.status).toBe(201);
  });

  it("emits a UTC (Z) timestamp", async () => {
    const response = jsonOk(null, { requestId: "r" });
    const parsed = (await response.json()) as { timestamp: string };
    expect(parsed.timestamp.endsWith("Z")).toBe(true);
  });
});

describe("jsonError", () => {
  it("wraps the error payload with code, message and traceability", async () => {
    const response = jsonError(
      { code: "VALIDATION_ERROR", message: "bad", details: [{ path: "m" }] },
      { requestId: "req-9", status: 400 },
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe("req-9");

    const body = (await response.json()) as {
      ok: boolean;
      error: { code: string; message: string; details: unknown };
      requestId: string;
      timestamp: string;
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("bad");
    expect(body.error.details).toEqual([{ path: "m" }]);
    expect(body.requestId).toBe("req-9");
    expect(body.timestamp).toMatch(UTC_ISO_PATTERN);
  });

  it("omits the details field when there are none", async () => {
    const response = jsonError(
      { code: "NOT_FOUND", message: "nope" },
      { requestId: "r", status: 404 },
    );
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect("details" in body.error).toBe(false);
  });

  it("propagates extra headers (e.g. allow for 405)", () => {
    const response = jsonError(
      { code: "METHOD_NOT_ALLOWED", message: "no" },
      { requestId: "r", status: 405, headers: { allow: "GET" } },
    );
    expect(response.headers.get("allow")).toBe("GET");
  });
});
