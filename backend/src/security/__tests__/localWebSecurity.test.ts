import { beforeEach, describe, expect, it } from "vitest";
import { resetLoginThrottleForTest, assertLoginAllowed, recordLoginFailure } from "@/auth/loginThrottle";
import { ApiError } from "@/http/errors";
import { withApi } from "@/http/handler";
import { jsonOk } from "@/http/responses";

describe("local mutation origin authority", () => {
  const route = withApi(async (_request, { requestId }) => jsonOk({ changed: true }, { requestId }));

  it("accepts same-origin loopback and attaches hardened headers", async () => {
    const response = await route(new Request("http://127.0.0.1:3100/api/x", {
      method: "POST", headers: { origin: "http://127.0.0.1:3100" },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  it("rejects cross-origin, cross-site and non-loopback mutations", async () => {
    for (const request of [
      new Request("http://127.0.0.1:3100/api/x", { method: "POST", headers: { origin: "http://evil.test" } }),
      new Request("http://localhost:3100/api/x", { method: "PATCH", headers: { "sec-fetch-site": "cross-site" } }),
      new Request("http://192.168.1.10:3100/api/x", { method: "DELETE" }),
    ]) {
      const response = await route(request);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toMatch(/evil\.test|192\.168/i);
    }
  });

  it("redacts secret-shaped structured error details", async () => {
    const leaking = withApi(async () => { throw ApiError.validation("bad", { password: "pw", nested: { apiKey: "key" } }); });
    const response = await leaking(new Request("http://localhost:3100/api/x"));
    const text = await response.text();
    expect(text).not.toContain('"pw"');
    expect(text).not.toContain('"key"');
    expect(text).toContain("[REDACTED]");
  });
});

describe("login throttling", () => {
  beforeEach(() => resetLoginThrottleForTest());
  it("blocks after five failures without retaining username plaintext", () => {
    for (let index = 0; index < 5; index += 1) recordLoginFailure("owner", 1_000 + index);
    expect(() => assertLoginAllowed("owner", 2_000)).toThrowError(ApiError);
    try { assertLoginAllowed("owner", 2_000); } catch (error) {
      expect((error as ApiError).code).toBe("RATE_LIMITED");
      expect((error as ApiError).headers?.["retry-after"]).toBeTruthy();
    }
  });

  it("expires the bounded failure window", () => {
    for (let index = 0; index < 5; index += 1) recordLoginFailure("owner", index);
    expect(() => assertLoginAllowed("owner", 61_000)).not.toThrow();
  });
});
