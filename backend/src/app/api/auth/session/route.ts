/**
 * `GET /api/auth/session` (P01-04) — private session view.
 *
 * This is the guard's reference implementation and the health check for the
 * frontend protected area: it calls `requireSession`, so an unauthenticated
 * request receives a structured 401 (route unreachable without a valid
 * session cookie).
 */
import { requireSession } from "@/auth/guard";
import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { jsonOk } from "@/http/responses";

export const dynamic = "force-dynamic";

export const GET = withApi(async (request, { requestId }) => {
  const { session, user } = await requireSession(request);
  return jsonOk(
    {
      user: {
        id: user.id,
        username: user.username,
      },
      session: {
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
      },
    },
    { requestId },
  );
});

const methodNotAllowedHandler = withApi(async () => {
  throw ApiError.methodNotAllowed(["GET"]);
});

export const POST = methodNotAllowedHandler;
export const PUT = methodNotAllowedHandler;
export const PATCH = methodNotAllowedHandler;
export const DELETE = methodNotAllowedHandler;
