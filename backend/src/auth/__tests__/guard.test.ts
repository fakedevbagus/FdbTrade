/**
 * Unit tests for the authorization guard (P01-04) — mocked store.
 *
 * Covers: no cookie → 401; unknown/expired token → 401; valid token →
 * session/user returned; DB outage → fail-closed 401; result contains no
 * secret material.
 */
import { describe, expect, it, vi } from "vitest";

import { readSessionCookie, requireSession } from "@/auth/guard";
import { ApiError } from "@/http/errors";
import { SESSION_COOKIE_NAME } from "@/auth/store";

const sessionFixture = {
  session: {
    id: "sess-1",
    userId: "user-1",
    createdAt: "2026-09-08T00:00:00.000Z",
    expiresAt: "2026-09-15T00:00:00.000Z",
  },
  user: {
    id: "user-1",
    username: "owner",
    isActive: true,
    mfaEnabled: false,
  },
};

const getSessionByToken = vi.fn();
vi.mock("@/auth/store", () => ({
  SESSION_COOKIE_NAME: "fdb_session",
  getSessionByToken: (...args: unknown[]) => getSessionByToken(...args),
}));

function requestWithCookie(cookie?: string): Request {
  return new Request("http://localhost/api/private", {
    headers: cookie !== undefined ? { cookie } : {},
  });
}

describe("readSessionCookie", () => {
  it("extracts the fdb_session value", () => {
    const request = requestWithCookie(
      `other=x; ${SESSION_COOKIE_NAME}=abc123; more=y`,
    );
    expect(readSessionCookie(request)).toBe("abc123");
  });

  it("returns null without a cookie header or with other cookies only", () => {
    expect(readSessionCookie(requestWithCookie())).toBeNull();
    expect(
      readSessionCookie(requestWithCookie("other=x; another=y")),
    ).toBeNull();
  });
});

describe("requireSession", () => {
  it("throws 401 without a session cookie", async () => {
    await expect(requireSession(requestWithCookie())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      status: 401,
    });
  });

  it("throws 401 for an unknown/expired token", async () => {
    getSessionByToken.mockResolvedValue(null);
    await expect(
      requireSession(requestWithCookie(`${SESSION_COOKIE_NAME}=stale`)),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
  });

  it("returns the session and user for a valid token", async () => {
    getSessionByToken.mockResolvedValue(sessionFixture);
    const result = await requireSession(
      requestWithCookie(`${SESSION_COOKIE_NAME}=good`),
    );
    expect(result.user.username).toBe("owner");
    expect(JSON.stringify(result)).not.toContain("password");
  });

  it("fails closed with 401 when the database is unreachable", async () => {
    getSessionByToken.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(
      requireSession(requestWithCookie(`${SESSION_COOKIE_NAME}=good`)),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
  });

  it("rethrows structured ApiErrors unchanged", async () => {
    getSessionByToken.mockRejectedValue(ApiError.unauthorized());
    await expect(
      requireSession(requestWithCookie(`${SESSION_COOKIE_NAME}=x`)),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
