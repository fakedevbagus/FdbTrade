/**
 * Unit tests for the withApi handler wrapper (P01-02).
 *
 * Covers: happy path (context identity propagation), ApiError mapping,
 * unknown-failure collapse (message never leaked), and header fallback when
 * middleware did not run.
 */
import { describe, expect, it } from "vitest";

import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";

function requestWithHeaders(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/x", { headers });
}

describe("withApi", () => {
  it("passes the handler response through and supplies identity context", async () => {
    const handler = withApi(async (_request, context) => {
      return new Response(JSON.stringify(context), {
        headers: { "content-type": "application/json" },
      });
    });
    const response = await handler(
      requestWithHeaders({ "x-request-id": "req-1", "x-correlation-id": "corr-1" }),
    );
    const body = (await response.json()) as Record<string, string>;
    expect(body.requestId).toBe("req-1");
    expect(body.correlationId).toBe("corr-1");
  });

  it("generates identity when middleware did not run (fallback)", async () => {
    const handler = withApi(async (_request, context) => {
      return new Response(JSON.stringify(context));
    });
    const response = await handler(new Request("http://localhost/api/x"));
    const body = (await response.json()) as Record<string, string>;
    expect(body.requestId).toBeTruthy();
    expect(body.correlationId).toBe(body.requestId);
  });

  it("maps ApiError to a structured response with status and headers", async () => {
    const handler = withApi(async () => {
      throw ApiError.methodNotAllowed(["GET"]);
    });
    const response = await handler(new Request("http://localhost/api/x"));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(response.headers.get("x-request-id")).toBeTruthy();
    const body = (await response.json()) as {
      ok: boolean;
      error: { code: string; details: { allowed: string[] } };
      requestId: string;
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("METHOD_NOT_ALLOWED");
    expect(body.error.details.allowed).toEqual(["GET"]);
    expect(body.requestId).toBeTruthy();
  });

  it("collapses unknown failures to a generic structured 500 (no leak)", async () => {
    const secretDetail = "s3cret-internal-value";
    const handler = withApi(async () => {
      throw new Error(`database exploded: ${secretDetail}`);
    });
    const response = await handler(
      requestWithHeaders({ "x-request-id": "req-err" }),
    );
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain(secretDetail);
    expect(text).not.toContain("database exploded");
    const body = JSON.parse(text) as {
      ok: boolean;
      error: { code: string; message: string };
      requestId: string;
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("Internal server error.");
    expect(body.requestId).toBe("req-err");
  });

  it("rejects non-Error thrown values the same way (no leak)", async () => {
    const handler = withApi(async () => {
      throw "raw string failure with s3cret";
    });
    const response = await handler(new Request("http://localhost/api/x"));
    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("Internal server error.");
  });

  it("supports synchronous handlers", async () => {
    const handler = withApi(() => new Response("sync-ok", { status: 200 }));
    const response = await handler(new Request("http://localhost/api/x"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("sync-ok");
  });
});
