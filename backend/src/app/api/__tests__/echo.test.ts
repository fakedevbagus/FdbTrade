/**
 * Unit tests for the echo validation fixture and the env schema (P01-02).
 */
import { describe, expect, it } from "vitest";

import { GET as echoGet, POST as echoPost } from "@/app/api/echo/route";
import { apiEnvSchema } from "@/env";

function jsonPostRequest(body: string): Request {
  return new Request("http://localhost/api/echo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("POST /api/echo (validation contract fixture)", () => {
  it("echoes a valid body with defaults applied", async () => {
    const response = await echoPost(
      jsonPostRequest(JSON.stringify({ message: "ping" })),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: { message: string; count: number };
      requestId: string;
    };
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({ message: "ping", count: 1 });
    expect(body.requestId).toBeTruthy();
  });

  it("echoes a fully-specified valid body", async () => {
    const response = await echoPost(
      jsonPostRequest(JSON.stringify({ message: "ping", count: 7 })),
    );
    const body = (await response.json()) as {
      data: { message: string; count: number };
    };
    expect(body.data).toMatchObject({ message: "ping", count: 7 });
  });

  it("returns structured INVALID_JSON for a malformed body", async () => {
    const response = await echoPost(jsonPostRequest("{nope"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("INVALID_JSON");
  });

  it("returns structured VALIDATION_ERROR with details for a schema violation", async () => {
    const response = await echoPost(
      jsonPostRequest(JSON.stringify({ count: 2 })),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: {
        code: string;
        details: Array<{ path: string; message: string }>;
      };
    };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details[0].path).toBe("message");
  });

  it("returns structured UNSUPPORTED_MEDIA_TYPE for a non-JSON content type", async () => {
    const response = await echoPost(
      new Request("http://localhost/api/echo", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "hello",
      }),
    );
    expect(response.status).toBe(415);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("returns a structured 405 for GET", async () => {
    const response = await echoGet(new Request("http://localhost/api/echo"));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});

describe("apiEnvSchema", () => {
  it("applies safe defaults when nothing is set", () => {
    const env = apiEnvSchema.parse({});
    expect(env.FDB_APP_ENV).toBe("development");
    expect(env.FDB_API_SERVICE_NAME).toBe("fdbtrade-api");
    expect(env.FDB_API_VERSION).toBe("0.1.0");
    expect(env.FDB_API_MAX_BODY_BYTES).toBe(65_536);
  });

  it("accepts every deployment environment value", () => {
    for (const value of ["development", "testing", "staging", "production"]) {
      expect(apiEnvSchema.parse({ FDB_APP_ENV: value }).FDB_APP_ENV).toBe(
        value,
      );
    }
  });

  it("coerces and bounds the body-size knob", () => {
    expect(
      apiEnvSchema.parse({ FDB_API_MAX_BODY_BYTES: "2048" })
        .FDB_API_MAX_BODY_BYTES,
    ).toBe(2048);
    expect(() =>
      apiEnvSchema.parse({ FDB_API_MAX_BODY_BYTES: "0" }),
    ).toThrow();
    expect(() =>
      apiEnvSchema.parse({ FDB_API_MAX_BODY_BYTES: "99999999" }),
    ).toThrow();
  });

  it("rejects an unknown environment and empty service names", () => {
    expect(() => apiEnvSchema.parse({ FDB_APP_ENV: "chaos" })).toThrow();
    expect(() =>
      apiEnvSchema.parse({ FDB_API_SERVICE_NAME: "" }),
    ).toThrow();
  });
});
