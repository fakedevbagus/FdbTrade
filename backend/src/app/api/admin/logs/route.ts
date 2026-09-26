/**
 * `GET /api/admin/logs` — structured log query surface (P13-01).
 *
 * Read-only view over the process-wide observability log: latest records,
 * optionally filtered by correlation id. Log payloads are redacted and
 * validated by the contracts schema — no secrets can appear here by
 * construction (ADR-0024).
 */
import { requireSession } from "@/auth/guard";
import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { jsonOk } from "@/http/responses";
import { obsService } from "@/obs/service";
import { isValidTraceId } from "@/http/request-context";

export const dynamic = "force-dynamic";

export const GET = withApi(async (request, { requestId }) => {
  await requireSession(request);
  const url = new URL(request.url);
  const correlationId = url.searchParams.get("correlationId");
  if (correlationId !== null && !isValidTraceId(correlationId)) {
    throw ApiError.validation("correlationId must be a well-formed trace id.");
  }
  const records =
    correlationId === null
      ? obsService.records()
      : obsService.recordsForCorrelation(correlationId);
  return jsonOk({ records: [...records].slice(-500) }, { requestId });
});

const methodNotAllowedHandler = withApi(async () => {
  throw ApiError.methodNotAllowed(["GET"]);
});

export const POST = methodNotAllowedHandler;
export const PUT = methodNotAllowedHandler;
export const PATCH = methodNotAllowedHandler;
export const DELETE = methodNotAllowedHandler;