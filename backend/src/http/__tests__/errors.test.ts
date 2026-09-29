/**
 * Unit tests for the ApiError taxonomy (P01-02).
 *
 * Covers: valid construction, every code's status mapping, boundary helpers,
 * and the 405 `allow` header contract.
 */
import { describe, expect, it } from "vitest";

import {
  API_ERROR_CODES,
  ApiError,
  STATUS_BY_CODE,
} from "@/http/errors";

describe("ApiError", () => {
  it("constructs with code, status, message and no details by default", () => {
    const error = new ApiError("NOT_FOUND", "missing thing");
    expect(error.code).toBe("NOT_FOUND");
    expect(error.status).toBe(404);
    expect(error.message).toBe("missing thing");
    expect(error.details).toBeUndefined();
    expect(error.headers).toBeUndefined();
    expect(error instanceof Error).toBe(true);
  });

  it("maps every known code to the documented status", () => {
    const expected: Record<string, number> = {
      VALIDATION_ERROR: 400,
      INVALID_JSON: 400,
      UNSUPPORTED_MEDIA_TYPE: 415,
      PAYLOAD_TOO_LARGE: 413,
      UNAUTHORIZED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      METHOD_NOT_ALLOWED: 405,
      INTERNAL_ERROR: 500,
      RATE_LIMITED: 429,
      REPLAY_DETECTED: 409,
      LEGACY_SURFACE_RETIRED: 410,
    };
    expect([...API_ERROR_CODES].sort()).toEqual(Object.keys(expected).sort());
    for (const code of API_ERROR_CODES) {
      expect(STATUS_BY_CODE[code]).toBe(expected[code]);
    }
  });

  it("validation() defaults to 400 with optional details", () => {
    const error = ApiError.validation("bad input", [{ path: "message" }]);
    expect(error.status).toBe(400);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.details).toEqual([{ path: "message" }]);
  });

  it("forbidden() maps to 403 FORBIDDEN (P13-05 RBAC)", () => {
    const error = ApiError.forbidden("role viewer may not perform engage_kill");
    expect(error.status).toBe(403);
    expect(error.code).toBe("FORBIDDEN");
    expect(error.details).toBeUndefined();
  });

  it("methodNotAllowed() carries allowed methods in details and allow header", () => {
    const error = ApiError.methodNotAllowed(["GET"]);
    expect(error.status).toBe(405);
    expect(error.code).toBe("METHOD_NOT_ALLOWED");
    expect(error.details).toEqual({ allowed: ["GET"] });
    expect(error.headers).toEqual({ allow: "GET" });
  });

  it("methodNotAllowed() lists multiple methods", () => {
    const error = ApiError.methodNotAllowed(["GET", "POST"]);
    expect(error.headers?.allow).toBe("GET, POST");
  });

  it("supports explicit status override via options", () => {
    const error = new ApiError("INTERNAL_ERROR", "boom", { status: 503 });
    expect(error.status).toBe(503);
  });

  it("helper defaults produce safe generic messages", () => {
    expect(ApiError.internal().message).toBe("Internal server error.");
    expect(ApiError.invalidJson().message).toBe(
      "Request body is not valid JSON.",
    );
    expect(ApiError.unsupportedMediaType().message).toBe(
      "Content-Type must be application/json.",
    );
    expect(ApiError.payloadTooLarge().message).toBe(
      "Request body exceeds the maximum accepted size.",
    );
    expect(ApiError.notFound().message).toBe("Resource not found.");
    expect(ApiError.rateLimited().message).toBe(
      "Too many requests. Please try again later.",
    );
    expect(ApiError.replayDetected().message).toBe(
      "Duplicate request detected. Please retry with a new request ID.",
    );
    expect(ApiError.legacySurfaceRetired().message).toBe("This legacy surface is retired.");
  });

  it("supports rate-limited and replay-detected helpers with correct statuses", () => {
    const limited = ApiError.rateLimited();
    expect(limited.code).toBe("RATE_LIMITED");
    expect(limited.status).toBe(429);

    const replayed = ApiError.replayDetected();
    expect(replayed.code).toBe("REPLAY_DETECTED");
    expect(replayed.status).toBe(409);
    expect(ApiError.legacySurfaceRetired().status).toBe(410);
  });
});
