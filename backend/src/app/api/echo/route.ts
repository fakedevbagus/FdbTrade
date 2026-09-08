/**
 * `POST /api/echo` — validation-contract fixture (P01-02).
 *
 * This endpoint exists so the request-validation boundary can be exercised
 * end to end (unit tests call the handler directly; the Python contract test
 * calls the real server). It carries NO business logic and touches no
 * strategy/risk/execution concern — it validates a body and echoes the
 * validated fields back inside the standard envelope.
 */
import { z } from "zod";

import { utcNowIso } from "@/clock";
import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { jsonOk } from "@/http/responses";
import { parseJsonBody } from "@/http/validate";

export const dynamic = "force-dynamic";

export const echoRequestSchema = z.object({
  message: z.string().min(1).max(1_000),
  count: z.number().int().min(0).max(100).default(1),
});

export const POST = withApi(async (request, { requestId }) => {
  const body = await parseJsonBody(request, echoRequestSchema);
  return jsonOk(
    {
      message: body.message,
      count: body.count,
      receivedAtUtc: utcNowIso(),
    },
    { requestId },
  );
});

const methodNotAllowedHandler = withApi(async () => {
  throw ApiError.methodNotAllowed(["POST"]);
});

export const GET = methodNotAllowedHandler;
export const PUT = methodNotAllowedHandler;
export const PATCH = methodNotAllowedHandler;
export const DELETE = methodNotAllowedHandler;
