/**
 * `GET /api/admin/traces/[signalId]` — end-to-end trace view (P13-01).
 *
 * Assembles the recorded spans for one signal into the canonical trace
 * (decision -> risk -> execution -> outcome), with a machine-readable
 * completeness flag. A signal with no spans is a structured 404 — a trace is
 * never fabricated (fail closed, no green-by-default).
 */
import { requireSession } from "@/auth/guard";
import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { jsonOk } from "@/http/responses";
import { obsService } from "@/obs/service";

export const dynamic = "force-dynamic";

export const GET = withApi(async (request, { requestId }) => {
  await requireSession(request);
  const url = new URL(request.url);
  const signalId = url.pathname.split("/").filter(Boolean).pop() ?? "";
  if (signalId === "") {
    throw ApiError.validation("signalId is required.");
  }
  const trace = obsService.traceFor(signalId);
  if (trace === null) {
    throw ApiError.notFound(`No trace recorded for signal ${signalId}.`);
  }
  return jsonOk(trace, { requestId });
});

const methodNotAllowedHandler = withApi(async () => {
  throw ApiError.methodNotAllowed(["GET"]);
});

export const POST = methodNotAllowedHandler;
export const PUT = methodNotAllowedHandler;
export const PATCH = methodNotAllowedHandler;
export const DELETE = methodNotAllowedHandler;
