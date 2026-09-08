/**
 * `POST /api/auth/logout` (P01-04) — delete the DB session, clear the cookie.
 * Idempotent: no valid session → still 200 (never an auth oracle).
 */
import { deleteSessionByToken } from "@/auth/store";
import { readSessionCookie } from "@/auth/guard";
import { withApi } from "@/http/handler";
import { jsonOk } from "@/http/responses";
import { SESSION_COOKIE_NAME } from "@/auth/store";

export const dynamic = "force-dynamic";

export const POST = withApi(async (request, { requestId }) => {
  const token = readSessionCookie(request);
  if (token) {
    try {
      await deleteSessionByToken(token);
    } catch {
      // Deleting a non-existent session is fine; DB outage during logout
      // still clears the client cookie (session ends client-side too).
    }
  }
  const response = jsonOk({ loggedOut: true }, { requestId });
  response.headers.append(
    "set-cookie",
    `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`,
  );
  return response;
});
