/**
 * Server-side auth session client for the web shell (P01-04).
 *
 * The frontend NEVER stores or validates credentials itself: it asks the
 * backend API (authoritative) whether the request's session cookie is valid,
 * and mirrors the cookie to the backend. No tokens, hashes, or passwords are
 * ever read, stored, or logged here (httpOnly cookies are opaque to JS by
 * design). The backend URL is the only configuration.
 */
import { cookies } from "next/headers";

/** Backend API origin. Server-side only; no secrets involved. */
export const BFF_API_URL =
  process.env.FDB_BFF_URL ?? "http://127.0.0.1:3100";

interface BffSessionResponse {
  ok: boolean;
  data?: {
    user: { id: string; username: string };
    session: { createdAt: string; expiresAt: string };
  };
}

export interface AuthSessionView {
  user: { id: string; username: string };
  session: { createdAt: string; expiresAt: string };
}

/**
 * Ask the backend whether this request has a valid session.
 * Returns null when unauthenticated (including backend outages — fail
 * closed) or on any unexpected response shape (schema-validated boundary).
 */
export async function fetchSession(): Promise<AuthSessionView | null> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("fdb_session");
  try {
    const response = await fetch(`${BFF_API_URL}/api/auth/session`, {
      headers: sessionCookie
        ? { cookie: `fdb_session=${sessionCookie.value}` }
        : {},
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status !== 200) {
      return null;
    }
    const body = (await response.json()) as BffSessionResponse;
    if (
      body?.ok !== true ||
      !body.data?.user?.id ||
      !body.data?.user?.username ||
      !body.data?.session?.expiresAt
    ) {
      return null; // malformed: fail closed
    }
    return {
      user: body.data.user,
      session: body.data.session,
    };
  } catch {
    return null; // backend unreachable: fail closed
  }
}
