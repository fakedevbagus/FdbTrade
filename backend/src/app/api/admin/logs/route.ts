/**
 * `GET /api/admin/logs` — bounded structured-log query surface (P13-01).
 *
 * Read-only and session-guarded. An optional correlation id narrows the
 * process-local observability ring; malformed ids fail closed. Responses are
 * capped to the latest 500 records.
 */
import { obsCorrelationIdSchema } from "@fdbtrade/contracts";

import { requireSession } from "@/auth/guard";
import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { jsonOk } from "@/http/responses";
import { obsService } from "@/obs/service";

export const dynamic = "force-dynamic";

export const GET = withApi(async (request, { requestId }) => {
  await requireSession(request);
  const correlationId = new URL(request.url).searchParams.get("correlationId");
  if (correlationId !== null && !obsCorrelationIdSchema.safeParse(correlationId).success) {
    throw ApiError.validation("correlationId is malformed.");
  }
  const records =
    correlationId === null
      ? obsService.records()
      : obsService.recordsForCorrelation(correlationId);
  return jsonOk(
    {
      count: records.length,
      records: [...records].slice(-500),
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