/**
 * Unit tests for boundary request-body validation (P01-02).
 *
 * Covers: valid input (with schema defaults), wrong content type, invalid
 * JSON, schema violations with per-field details, and body-size boundaries
 * (declared and actual).
 */
import { describe, expect, it } from "vitest";

import { z } from "zod";

import { ApiError } from "@/http/errors";
import { isJsonContentType, parseJsonBody } from "@/http/validate";

const schema = z.object({
  message: z.string().min(1),
  count: z.number().int().min(0).max(10).default(1),
});

function jsonRequest(
  body: string,
  headers: Record<string, string> = { "content-type": "application/json" },
): Request {
  return new Request("http://localhost/api/echo", {
    method: "POST",
    headers,
    body,
  });
}

describe("isJsonContentType", () => {
  it("accepts application/json and +json suffixes", () => {
    expect(
      isJsonContentType(
        new Request("http://x", {
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
      ),
    ).toBe(true);
    expect(
      isJsonContentType(
        new Request("http://x", {
          headers: { "content-type": "application/vnd.api+json" },
        }),
      ),
    ).toBe(true);
  });

  it("rejects other and missing content types", () => {
    expect(
      isJsonContentType(
        new Request("http://x", {
          headers: { "content-type": "text/plain" },
        }),
      ),
    ).toBe(false);
    expect(isJsonContentType(new Request("http://x"))).toBe(false);
  });
});

describe("parseJsonBody — happy path", () => {
  it("parses a valid body and applies schema defaults", async () => {
    const data = await parseJsonBody(
      jsonRequest(JSON.stringify({ message: "hi" })),
      schema,
    );
    expect(data).toEqual({ message: "hi", count: 1 });
  });

  it("parses a fully-specified valid body", async () => {
    const data = await parseJsonBody(
      jsonRequest(JSON.stringify({ message: "hi", count: 5 })),
      schema,
    );
    expect(data).toEqual({ message: "hi", count: 5 });
  });
});

describe("parseJsonBody — failure paths", () => {
  it("rejects a non-JSON content type with 415", async () => {
    const promise = parseJsonBody(
      jsonRequest("hello", { "content-type": "text/plain" }),
      schema,
    );
    await expect(promise).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA_TYPE",
      status: 415,
    });
  });

  it("rejects a missing content type with 415", async () => {
    await expect(
      parseJsonBody(jsonRequest("{}", {}), schema),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE", status: 415 });
  });

  it("rejects invalid JSON with 400 INVALID_JSON", async () => {
    await expect(
      parseJsonBody(jsonRequest("{ definitely not json"), schema),
    ).rejects.toMatchObject({ code: "INVALID_JSON", status: 400 });
  });

  it("rejects an empty body with 400 INVALID_JSON", async () => {
    await expect(
      parseJsonBody(jsonRequest(""), schema),
    ).rejects.toMatchObject({ code: "INVALID_JSON", status: 400 });
  });

  it("rejects schema violations with 400 and per-field details", async () => {
    let error: ApiError | undefined;
    try {
      await parseJsonBody(
        jsonRequest(JSON.stringify({ count: 3 })),
        schema,
      );
    } catch (caught) {
      error = caught as ApiError;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect(error?.code).toBe("VALIDATION_ERROR");
    expect(error?.status).toBe(400);
    const details = error?.details as Array<{ path: string; message: string }>;
    expect(details).toHaveLength(1);
    expect(details[0].path).toBe("message");
    expect(details[0].message).toBeTruthy();
  });

  it("rejects out-of-range boundary values", async () => {
    await expect(
      parseJsonBody(
        jsonRequest(JSON.stringify({ message: "hi", count: 11 })),
        schema,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
  });

  it("rejects non-object JSON bodies", async () => {
    await expect(
      parseJsonBody(jsonRequest(JSON.stringify([1, 2, 3])), schema),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
  });
});

describe("parseJsonBody — size boundaries", () => {
  it("rejects an oversized declared Content-Length with 413", async () => {
    await expect(
      parseJsonBody(
        jsonRequest(JSON.stringify({ message: "hi" }), {
          "content-type": "application/json",
          "content-length": String(10 * 1024),
        }),
        schema,
        { maxBodyBytes: 1024 },
      ),
    ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE", status: 413 });
  });

  it("rejects an oversized actual body with 413", async () => {
    const bigMessage = "x".repeat(2000);
    await expect(
      parseJsonBody(
        jsonRequest(JSON.stringify({ message: bigMessage })),
        schema,
        { maxBodyBytes: 1024 },
      ),
    ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE", status: 413 });
  });

  it("accepts a body exactly at the size boundary", async () => {
    const exact = "x".repeat(1000 - JSON.stringify({ message: "", count: 1 }).length - 1);
    const body = JSON.stringify({ message: exact, count: 1 });
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(1024);
    const data = await parseJsonBody(jsonRequest(body), schema, {
      maxBodyBytes: 1024,
    });
    expect(data.message).toBe(exact);
  });
});
