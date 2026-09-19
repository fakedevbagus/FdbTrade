/**
 * `GET /api/admin/audit` — audit log query surface (P13-02).
 *
 * Read-only, session-guarded view over the append-only audit log. Supports
 * optional `subjectId` filter. The response carries the latest 500 events
 * plus the current stream digest (tamper-evidence). No write method exists:
 * audit entries are appended by privileged mutations inside their owning
 * services (admin controls in P13-05), never by client POST.
 */
import { requireSession } from "@/auth/guard";
import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { jsonOk } from "@/http/responses";
import { auditService } from "@/obs/auditService";

export const dynamic = "force-dynamic";

export const GET = withApi(async (request, { requestId }) => {
  await requireSession(request);
  const url = new URL(request.url);
  const subjectId = url.searchParams.get("subjectId");
  if (subjectId !== null && (subjectId.length === 0 || subjectId.length > 128)) {
    throw ApiError.validation("subjectId must be 1-128 characters.");
  }
  const events =
    subjectId === null ? auditService.events() : auditService.eventsForSubject(subjectId);
  return jsonOk(
    {
      digest: auditService.digest(),
      count: events.length,
      events: [...events].slice(-500),
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
