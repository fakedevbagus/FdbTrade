/**
 * Server-side authentication store (P01-04).
 *
 * Private single-user auth (ADR-0008): one active user row, DB-backed
 * sessions that survive restarts, scrypt password hashing via node:crypto
 * (no external auth dependency). SECURITY invariants, contract-tested:
 * - Password hashes and raw session tokens are NEVER logged or returned.
 * - Session tokens are 32 random bytes; only their sha256 hash is stored.
 * - Cookie name `fdb_session`, httpOnly, SameSite=Lax, Secure in production.
 */
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { promisify } from "node:util";

import { getDatabase } from "@/db/client";
import { apiEnv } from "@/env";
import { withImmediateTransaction } from "@/db/sqlite.mjs";
import { assertServerOnly } from "@/server-only";

assertServerOnly();

/**
 * node:crypto scrypt promisified. promisify's typings only see the 3-arg
 * callback overload, so the options-carrying form is typed explicitly here.
 */
const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

// --- password hashing -------------------------------------------------------- //

export const SCRYPT_N = 16_384; // cost (2^14)
export const SCRYPT_r = 8;
export const SCRYPT_p = 1;
export const SCRYPT_KEYLEN = 64;

/**
 * Hash a password with scrypt. Output format: `scrypt$N$r$p$salt$hash`
 * (salt and hash are hex). Identical passwords produce different hashes
 * (random salt — standard password-hashing behavior, not a determinism bug).
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password.normalize("NFKC"), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
  })) as Buffer;
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

function parseStoredHash(stored: string):
  | { N: number; r: number; p: number; salt: Buffer; hash: Buffer }
  | null {
  const parts = stored.split("$");
  if (
    parts.length !== 6 ||
    parts[0] !== "scrypt" ||
    !/^\d+$/.test(parts[1]) ||
    !/^\d+$/.test(parts[2]) ||
    !/^\d+$/.test(parts[3])
  ) {
    return null;
  }
  try {
    return {
      N: Number(parts[1]),
      r: Number(parts[2]),
      p: Number(parts[3]),
      salt: Buffer.from(parts[4], "hex"),
      hash: Buffer.from(parts[5], "hex"),
    };
  } catch {
    return null;
  }
}

/** Constant-time password verification against a stored scrypt hash. */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parsed = parseStoredHash(stored);
  if (!parsed) {
    return false;
  }
  const derived = (await scrypt(
    password.normalize("NFKC"),
    parsed.salt,
    parsed.hash.length,
    { N: parsed.N, r: parsed.r, p: parsed.p },
  )) as Buffer;
  return (
    derived.length === parsed.hash.length &&
    timingSafeEqual(derived, parsed.hash)
  );
}

// --- session tokens ----------------------------------------------------------- //

export const SESSION_COOKIE_NAME = "fdb_session";
/** Session lifetime: 7 days. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Generate a new opaque session token (raw value only leaves via cookie). */
export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Stable storage form: sha256 hex of the raw token. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// --- user/session records ------------------------------------------------------ //

export interface AuthUser {
  id: string;
  username: string;
  isActive: boolean;
  mfaEnabled: boolean;
}

export interface AuthSession {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface AuthResult {
  session: AuthSession;
  user: AuthUser;
}

export interface AuthUserRow {
  id: string;
  username: string;
  is_active: number;
  mfa_enabled: number;
}

function toAuthUser(row: AuthUserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    isActive: row.is_active === 1,
    mfaEnabled: row.mfa_enabled === 1,
  };
}

export async function getUserByUsername(
  username: string,
): Promise<AuthUser | null> {
  const row = getDatabase()
    .prepare(
      "SELECT id, username, is_active, mfa_enabled FROM users WHERE username = ?",
    )
    .get(username) as unknown as AuthUserRow | undefined;
  return row ? toAuthUser(row) : null;
}

export async function getUserById(userId: string): Promise<AuthUser | null> {
  const row = getDatabase()
    .prepare("SELECT id, username, is_active, mfa_enabled FROM users WHERE id = ?")
    .get(userId) as unknown as AuthUserRow | undefined;
  return row ? toAuthUser(row) : null;
}

/**
 * Validate credentials and create a DB-backed session. Returns null for
 * unknown username OR bad password (same result — no user enumeration) and
 * for inactive users. Database failures propagate as errors (fail closed,
 * never a false "unauthorized" that hides an outage).
 *
 * The raw token is returned exactly once; only its sha256 hash is stored.
 */
export async function login(
  username: string,
  password: string,
): Promise<AuthResult & { token: string } | null> {
  const row = getDatabase()
    .prepare(
      "SELECT id, password_hash, is_active FROM users WHERE username = ?",
    )
    .get(username) as unknown as
    | {
    id: string;
    password_hash: string;
    is_active: number;
  }
    | undefined;
  if (!row || row.is_active !== 1) {
    return null;
  }
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) {
    return null;
  }
  const user = await getUserById(row.id);
  if (!user) {
    return null;
  }
  const token = createSessionToken();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_SECONDS * 1_000);
  const sessionId = randomUUID();
  const database = getDatabase();
  withImmediateTransaction(database, () => {
    // Single-user rotation: a successful login revokes every older session.
    database.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
    database
      .prepare(
        `INSERT INTO sessions
           (id, token_hash, user_id, created_at_utc, expires_at_utc, last_used_at_utc)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        hashSessionToken(token),
        user.id,
        createdAt.toISOString(),
        expiresAt.toISOString(),
        createdAt.toISOString(),
      );
  });
  return {
    token,
    user,
    session: {
      id: sessionId,
      userId: user.id,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    },
  };
}

interface SessionJoinRow {
  id: string;
  user_id: string;
  created_at_utc: string;
  expires_at_utc: string;
  username: string;
  is_active: number;
  mfa_enabled: number;
}

/**
 * Resolve a session from a raw token. Expired, unknown, or inactive-user
 * tokens return null. Valid tokens get `last_used_at` refreshed.
 */
export async function getSessionByToken(
  token: string,
): Promise<AuthResult | null> {
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }
  const database = getDatabase();
  const row = database.prepare(
    `SELECT s.id, s.user_id, s.created_at_utc, s.expires_at_utc,
            u.username, u.is_active, u.mfa_enabled
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at_utc > ?`,
  ).get(hashSessionToken(token), new Date().toISOString()) as unknown as
    | SessionJoinRow
    | undefined;
  if (!row || row.is_active !== 1) {
    return null;
  }
  database
    .prepare("UPDATE sessions SET last_used_at_utc = ? WHERE id = ?")
    .run(new Date().toISOString(), row.id);
  return {
    session: {
      id: row.id,
      userId: row.user_id,
      createdAt: row.created_at_utc,
      expiresAt: row.expires_at_utc,
    },
    user: {
      id: row.user_id,
      username: row.username,
      isActive: row.is_active === 1,
      mfaEnabled: row.mfa_enabled === 1,
    },
  };
}

/** Delete a session by its raw token (logout). Missing tokens are a no-op. */
export async function deleteSessionByToken(token: string): Promise<void> {
  getDatabase()
    .prepare("DELETE FROM sessions WHERE token_hash = ?")
    .run(hashSessionToken(token));
}

/** Cookie attributes for the session cookie (httpOnly; Secure in production). */
export function sessionCookieAttributes(): {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: apiEnv.FDB_APP_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}
