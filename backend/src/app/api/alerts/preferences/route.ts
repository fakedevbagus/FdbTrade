/**
 * `GET/PUT /api/alerts/preferences` (P07-05) — in-app alert preferences.
 *
 * GET returns the current preferences; PUT validates + replaces them
 * (zod-strict, fail closed). Preferences never affect signal creation —
 * they only gate alert delivery (dispatch skips, it never blocks).
 */
import { requireSession } from "@/auth/guard";
import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { jsonOk } from "@/http/responses";
import { parseJsonBody } from "@/http/validate";
import { getDatabase } from "@/db/client";
import { alertPreferencesSchema, DurableAlertCenter } from "@/signals/alerts";

export const dynamic = "force-dynamic";

export const GET = withApi(async (request, { requestId }) => {
  await requireSession(request);
  return jsonOk(new DurableAlertCenter(getDatabase()).getPreferences(), { requestId });
});

export const PUT = withApi(async (request, { requestId }) => {
  await requireSession(request);
  const raw = await parseJsonBody(request, alertPreferencesSchema);
  const stored = new DurableAlertCenter(getDatabase()).setPreferences(raw);
  return jsonOk(stored, { requestId });
});

const methodNotAllowedHandler = withApi(async () => {
  throw ApiError.methodNotAllowed(["GET", "PUT"]);
});

export const POST = methodNotAllowedHandler;
export const PATCH = methodNotAllowedHandler;
export const DELETE = methodNotAllowedHandler;
