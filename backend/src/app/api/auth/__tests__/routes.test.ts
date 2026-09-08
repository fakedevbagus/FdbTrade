/**
 * Unit tests for the auth API routes (P01-04) — mocked store.
 *
 * Covers: login happy path (cookie set, no secret in body), bad credentials
 * → identical structured 401, malformed bodies → 400, logout idempotency,
 * and the guarded session route (401 without a cookie, 200 with one).
 */
import { describe, expect, it, vi } from "vitest";

import { POST as loginPost } from "@/app/api/auth/login/route";
import { POST as logoutPost } from "@/app/api/auth/logout/route";
import { GET as sessionGet } from "@/app/api/auth/session/route";

const loginMock = vi.fn();
const deleteSessionByTokenMock = vi.fn();
const getSessionByTokenMock = vi.fn();

vi.mock("@/auth/store", async () => {
  const actual = await vi.importActual<
    typeof import("@/auth/store")
  >("@/auth/store");
  return {
    ...actual,
    login: (...args: unknown[]) => loginMock(...args),
    deleteSessionByToken: (...args: unknown[]) => deleteSessionByTokenMock(...args),
    getSessionByToken: (...args: unknown[]) => getSessionByTokenMock(...args),
  };
});

function jsonPost(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const sessionFixture = {
  session: {
    id: "sess-1",
    userId: "user-1",
    createdAt: "2026-09-08T00:00:00.000Z",
    expiresAt: "2026-09-15T00:00:00.000Z",
  },
  user: { id: "user-1", username: "owner", isActive: true, mfaEnabled: false },
};

describe("POST /api/auth/login", () => {
  it("sets the httpOnly session cookie and returns the session view", async () => {
    loginMock.mockResolvedValue({ ...sessionFixture, token: "raw-token-abc" });
    const response = await loginPost(
      jsonPost("/api/auth/login", { username: "owner", password: "pw123456" }),
    );
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("fdb_session=raw-token-abc");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Max-Age=604800");
    const body = (await response.json()) as {
      ok: boolean;
      data: { user: { username: string }; session: { expiresAt: string } };
    };
    expect(body.ok).toBe(true);
    expect(body.data.user.username).toBe("owner");
    expect(body.data.session.expiresAt).toMatch(/Z$/u);
    // No secret material in the body.
    const text = JSON.stringify(body);
    expect(text).not.toContain("raw-token-abc");
    expect(text).not.toContain("password");
  });

  it("returns the same structured 401 for unknown user and bad password", async () => {
    loginMock.mockResolvedValue(null);
    const unknown = await loginPost(
      jsonPost("/api/auth/login", { username: "ghost", password: "pw123456" }),
    );
    const wrongPw = await loginPost(
      jsonPost("/api/auth/login", { username: "owner", password: "wrong" }),
    );
    expect(unknown.status).toBe(401);
    expect(wrongPw.status).toBe(401);
    const bodyA = (await unknown.json()) as { error: { code: string; message: string } };
    const bodyB = (await wrongPw.json()) as { error: { code: string; message: string } };
    expect(bodyA.error.code).toBe("UNAUTHORIZED");
    expect(bodyB.error).toEqual(bodyA.error); // identical: no enumeration oracle
  });

  it("fails closed with 401 when the database is down", async () => {
    loginMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const response = await loginPost(
      jsonPost("/api/auth/login", { username: "owner", password: "pw123456" }),
    );
    expect(response.status).toBe(401);
    const text = await response.text();
    expect(text).not.toContain("ECONNREFUSED");
  });

  it("rejects malformed bodies with 400", async () => {
    const missing = await loginPost(
      jsonPost("/api/auth/login", { username: "owner" }),
    );
    expect(missing.status).toBe(400);
    const bad = await loginPost(jsonPost("/api/auth/login", "{nope"));
    expect(bad.status).toBe(400);
    const wrongType = await loginPost(
      jsonPost("/api/auth/login", { username: 42, password: "x" }),
    );
    expect(wrongType.status).toBe(400);
  });
});

describe("POST /api/auth/logout", () => {
  it("deletes the session and clears the cookie", async () => {
    deleteSessionByTokenMock.mockResolvedValue(undefined);
    const response = await logoutPost(
      new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: { cookie: "fdb_session=raw-token-abc" },
      }),
    );
    expect(response.status).toBe(200);
    expect(deleteSessionByTokenMock).toHaveBeenCalledWith("raw-token-abc");
    expect(response.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });

  it("is idempotent without a session cookie", async () => {
    deleteSessionByTokenMock.mockClear();
    const response = await logoutPost(
      new Request("http://localhost/api/auth/logout", { method: "POST" }),
    );
    expect(response.status).toBe(200);
    expect(deleteSessionByTokenMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/auth/session (guarded route)", () => {
  it("blocks unauthenticated access with a structured 401", async () => {
    const response = await sessionGet(
      new Request("http://localhost/api/auth/session"),
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns the session view when authenticated", async () => {
    getSessionByTokenMock.mockResolvedValue(sessionFixture);
    const response = await sessionGet(
      new Request("http://localhost/api/auth/session", {
        headers: { cookie: "fdb_session=raw-token-abc" },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { user: { username: string } };
    };
    expect(body.data.user.username).toBe("owner");
  });
});
