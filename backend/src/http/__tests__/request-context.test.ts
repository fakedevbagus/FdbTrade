/**
 * Unit tests for request/correlation identity (P01-02).
 *
 * Covers: generation when absent, round-tripping well-formed incoming IDs,
 * and replacement of malformed/oversized/injection-prone IDs (failure path).
 */
import { describe, expect, it } from "vitest";

import {
  CORRELATION_ID_HEADER,
  getOrCreateCorrelationId,
  getOrCreateRequestId,
  isValidTraceId,
  newTraceId,
  REQUEST_ID_HEADER,
} from "@/http/request-context";

function fakeRequest(headers: Record<string, string>) {
  return { headers: { get: (name: string) => headers[name] ?? null } };
}

describe("isValidTraceId", () => {
  it("accepts well-formed ids", () => {
    for (const value of [
      "abc123",
      "A",
      "req.1_2-3",
      "a".repeat(128),
    ]) {
      expect(isValidTraceId(value)).toBe(true);
    }
  });

  it("rejects malformed, oversized, and non-string values", () => {
    for (const value of [
      "",
      " leading-space",
      "has space",
      "no/slashes",
      "?query",
      "!bang",
      "a".repeat(129),
      null,
      undefined,
      42,
    ]) {
      expect(isValidTraceId(value)).toBe(false);
    }
  });
});

describe("getOrCreateRequestId", () => {
  it("generates a UUID when the header is missing", () => {
    const id = getOrCreateRequestId(fakeRequest({}));
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
  });

  it("reuses a well-formed incoming id unchanged (round-trip)", () => {
    const request = fakeRequest({ [REQUEST_ID_HEADER]: "req-abc.123" });
    expect(getOrCreateRequestId(request)).toBe("req-abc.123");
  });

  it("replaces a malformed incoming id (failure path)", () => {
    const request = fakeRequest({ [REQUEST_ID_HEADER]: "bad id with spaces" });
    const id = getOrCreateRequestId(request);
    expect(id).not.toBe("bad id with spaces");
    expect(isValidTraceId(id)).toBe(true);
  });

  it("replaces an oversized incoming id (boundary)", () => {
    const oversized = `${"a".repeat(129)}`;
    const id = getOrCreateRequestId(fakeRequest({ [REQUEST_ID_HEADER]: oversized }));
    expect(id).not.toBe(oversized);
    expect(isValidTraceId(id)).toBe(true);
  });

  it("is stable once the header is set (idempotent resolution)", () => {
    const headers: Record<string, string> = {};
    const request = { headers: { get: (n: string) => headers[n] ?? null } };
    const first = getOrCreateRequestId(request);
    headers[REQUEST_ID_HEADER] = first;
    expect(getOrCreateRequestId(request)).toBe(first);
  });
});

describe("getOrCreateCorrelationId", () => {
  it("falls back to the request id when the header is missing", () => {
    const id = getOrCreateCorrelationId(fakeRequest({}), "fallback-1");
    expect(id).toBe("fallback-1");
  });

  it("uses a well-formed incoming correlation id", () => {
    const request = fakeRequest({ [CORRELATION_ID_HEADER]: "corr-42" });
    expect(getOrCreateCorrelationId(request, "fallback-1")).toBe("corr-42");
  });

  it("replaces a malformed correlation id with the request id", () => {
    const request = fakeRequest({ [CORRELATION_ID_HEADER]: "../../etc" });
    expect(getOrCreateCorrelationId(request, "fallback-1")).toBe("fallback-1");
  });
});

describe("newTraceId", () => {
  it("produces unique, valid ids", () => {
    const a = newTraceId();
    const b = newTraceId();
    expect(a).not.toBe(b);
    expect(isValidTraceId(a)).toBe(true);
    expect(isValidTraceId(b)).toBe(true);
  });
});
