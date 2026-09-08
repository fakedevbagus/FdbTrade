/**
 * Unit tests for the auth store's pure crypto (P01-04).
 *
 * No database required — covers scrypt hash/verify round-trips, malformed
 * stored hashes, boundary inputs, and session-token properties. The live DB
 * flow is covered by `tests/test_auth_foundation_contracts.py`.
 */
import { describe, expect, it } from "vitest";

import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  SCRYPT_N,
  sessionCookieAttributes,
  SESSION_COOKIE_NAME,
  verifyPassword,
} from "@/auth/store";

describe("hashPassword / verifyPassword", () => {
  it("round-trips a password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored).toMatch(/^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/u);
    await expect(verifyPassword("correct horse battery staple", stored)).resolves.toBe(true);
  });

  it("rejects a wrong password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    await expect(verifyPassword("wrong password", stored)).resolves.toBe(false);
  });

  it("salts: identical passwords produce different hashes (both verify)", async () => {
    const a = await hashPassword("same-password-1");
    const b = await hashPassword("same-password-1");
    expect(a).not.toBe(b);
    await expect(verifyPassword("same-password-1", a)).resolves.toBe(true);
    await expect(verifyPassword("same-password-1", b)).resolves.toBe(true);
  });

  it("rejects malformed stored hashes (failure path)", async () => {
    for (const bad of [
      "",
      "plaintext",
      "bcrypt$2b$12$...",
      "scrypt$abc$8$1$salt$hash",
      "scrypt$16384$8$1$nothex$$",
    ]) {
      await expect(verifyPassword("any", bad)).resolves.toBe(false);
    }
  });

  it("uses the documented scrypt parameters", () => {
    expect(SCRYPT_N).toBe(16_384);
  });
});

describe("session tokens", () => {
  it("creates 32-byte base64url tokens (unique per call)", () => {
    const a = createSessionToken();
    const b = createSessionToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/u); // 32 bytes → 43 base64url chars
  });

  it("hashes tokens deterministically with sha256", () => {
    expect(hashSessionToken("token-a")).toBe(hashSessionToken("token-a"));
    expect(hashSessionToken("token-a")).not.toBe(hashSessionToken("token-b"));
    expect(hashSessionToken("token-a")).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("names the session cookie with the documented attributes", () => {
    expect(SESSION_COOKIE_NAME).toBe("fdb_session");
    const attrs = sessionCookieAttributes();
    expect(attrs.httpOnly).toBe(true);
    expect(attrs.sameSite).toBe("lax");
    expect(attrs.path).toBe("/");
    expect(attrs.maxAge).toBeGreaterThan(0);
  });
});
