/**
 * `GET /api/alerts/events` (P07-05) — recorded alert events (read-only).
 *
 * Delivery failures are surfaced here with their structured reason — never
 * hidden, never blocking signal creation (events are recorded even when
 * delivery is skipped/failed). POST dispatch is internal-only: no public
 * write endpoint exists (alert creation belongs to the pipeline, not the
 * client).
 */
import { requireSession } from "@/auth/guard";
import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { jsonOk } from "@/http/responses";
import { getDatabase } from "@/db/client";
import { DurableAlertCenter } from "@/signals/alerts";

export const dynamic = "force-dynamic";

export const GET = withApi(async (request, { requestId }) => {
  await requireSession(request);
  return jsonOk(
    { events: new DurableAlertCenter(getDatabase()).listEvents() },
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
