/**
 * Server-side authorization guard (P01-04).
 *
 * `requireSession` authenticates a request via its session cookie. It is the
 * single guard every private API route must call (server-side only — UI
 * checks are cosmetic, never security). Fail closed: missing cookie, unknown
 * token, expired session, inactive user, or database outage all raise a
 * structured 401; nothing about the failure distinguishes the case to the
 * client (no session-state oracle).
 */
import {
  getSessionByToken,
  SESSION_COOKIE_NAME,
  type AuthResult,
} from "@/auth/store";
import { ApiError } from "@/http/errors";

/** Read a cookie value from a Request's Cookie header (first match). */
export function readSessionCookie(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return null;
  }
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${SESSION_COOKIE_NAME}=`)) {
      return decodeURIComponent(trimmed.slice(SESSION_COOKIE_NAME.length + 1));
    }
  }
  return null;
}

/**
 * Authenticate a request or throw a structured 401. Returns the session and
 * user on success. The returned AuthResult never contains a token or
 * password hash — only ids, username, flags, and UTC timestamps.
 */
export async function requireSession(request: Request): Promise<AuthResult> {
  const token = readSessionCookie(request);
  if (!token) {
    throw ApiError.unauthorized();
  }
  try {
    const result = await getSessionByToken(token);
    if (!result) {
      throw ApiError.unauthorized();
    }
    return result;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    // Database outage while checking auth: fail closed (401 with the
    // standard message; the health endpoint separately surfaces the outage).
    throw ApiError.unauthorized();
  }
}
