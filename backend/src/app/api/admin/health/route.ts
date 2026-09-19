/**
 * `GET /api/admin/health` — provider/system health dashboard surface (P13-04).
 *
 * Read-only, session-guarded. Returns the computed health snapshot: state,
 * the EXPLICIT fail-safe behavior for that state, per-component checks with
 * staleness applied, latency/backlog metrics and machine-readable reasons.
 * Nothing here is green-by-default: stale or missing checks degrade or fail
 * closed (ADR-0027).
 */
import { requireSession } from "@/auth/guard";
import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { jsonOk } from "@/http/responses";
import { currentHealthSnapshot } from "@/obs/healthService";

export const dynamic = "force-dynamic";

export const GET = withApi(async (request, { requestId }) => {
  await requireSession(request);
  const snapshot = await currentHealthSnapshot();
  return jsonOk(snapshot, { requestId });
});

const methodNotAllowedHandler = withApi(async () => {
  throw ApiError.methodNotAllowed(["GET"]);
});

export const POST = methodNotAllowedHandler;
export const PUT = methodNotAllowedHandler;
export const PATCH = methodNotAllowedHandler;
export const DELETE = methodNotAllowedHandler;
