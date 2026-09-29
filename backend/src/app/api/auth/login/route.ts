/**
 * Auth API routes (P01-04).
 *
 * - `POST /api/auth/login`  — validate credentials, set the httpOnly session
 *   cookie, return the session (no password/token in any log or response).
 * - `POST /api/auth/logout` — delete the session, clear the cookie.
 * - `GET  /api/auth/session` — the guard's session view (private route; 401
 *   without a valid session).
 *
 * No user registration endpoint: the single user is provisioned by the
 * bootstrap script (private single-user product, ADR-0008).
 */
import { z } from "zod";

import {
  login,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  sessionCookieAttributes,
} from "@/auth/store";
import { withApi } from "@/http/handler";
import { assertLoginAllowed, recordLoginFailure, recordLoginSuccess } from "@/auth/loginThrottle";
import { ApiError } from "@/http/errors";
import { jsonOk } from "@/http/responses";
import { parseJsonBody } from "@/http/validate";

export const dynamic = "force-dynamic";

const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(1_000),
});

function sessionCookieHeader(token: string): string {
  const attrs = sessionCookieAttributes();
  const secure = attrs.secure ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function clearedCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`;
}

export const POST = withApi(async (request, { requestId }) => {
  const body = await parseJsonBody(request, loginSchema);
  assertLoginAllowed(body.username);

  let result;
  try {
    result = await login(body.username, body.password);
  } catch (error) {
    recordLoginFailure(body.username);
    // Database outage during login: fail closed with a generic 401 so no
    // outage/state oracle is exposed (health endpoint reports the outage).
    throw ApiError.unauthorized();
  }
  if (!result) {
    recordLoginFailure(body.username);
    // Bad username or bad password: identical response.
    throw ApiError.unauthorized();
  }
  recordLoginSuccess(body.username);

  const response = jsonOk(
    {
      user: {
        id: result.user.id,
        username: result.user.username,
      },
      session: {
        expiresAt: result.session.expiresAt,
      },
    },
    { requestId },
  );
  response.headers.append("set-cookie", sessionCookieHeader(result.token));
  return response;
});
