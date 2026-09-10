/**
 * `GET /api/signals/[id]` (P07-03) — full signal-detail view.
 *
 * Query contract (validated, fail closed):
 *   asOfUtc (required) — closed 1h bar the detail is evaluated from.
 * Path param: the deterministic decisionId (`ens_{instrument}_{tf}_{time}`).
 *
 * Every field the UI displays maps to a stored decision/signal field or is
 * explicitly labeled derived analytics (edge report, data quality). 404
 * when the decisionId does not exist at that bar — never improvised data.
 */
import { z } from "zod";

import { requireSession } from "@/auth/guard";
import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { jsonOk } from "@/http/responses";
import { buildSignalDetail } from "@/signals/pipeline";

export const dynamic = "force-dynamic";

const detailQuerySchema = z
  .object({
    asOfUtc: z.iso.datetime({ offset: false, precision: 3 }),
  })
  .strict();

const DECISION_ID_RE =
  /^ens_[A-Z0-9]+_(?:5m|15m|1h|4h|1d)_\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const getHandler = withApi(async (request, { requestId }) => {
  await requireSession(request);
  const url = new URL(request.url);
  // The route id is the last path segment (/api/signals/{id}).
  const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  if (!DECISION_ID_RE.test(id)) {
    throw ApiError.notFound("Signal not found.");
  }
  const raw = Object.fromEntries(url.searchParams.entries());
  const query = detailQuerySchema.safeParse(raw);
  if (!query.success) {
    throw ApiError.validation(
      "Query must contain exactly asOfUtc (UTC ISO instant, ms precision).",
    );
  }
  const detail = await buildSignalDetail({ asOfUtc: query.data.asOfUtc }, id);
  if (detail === null) {
    throw ApiError.notFound("Signal not found at the requested bar.");
  }
  return jsonOk(detail, { requestId });
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  void context; // params are recovered from the URL (single-source id).
  return getHandler(request);
}

const methodNotAllowedHandler = withApi(async () => {
  throw ApiError.methodNotAllowed(["GET"]);
});

export const POST = methodNotAllowedHandler;
export const PUT = methodNotAllowedHandler;
export const PATCH = methodNotAllowedHandler;
export const DELETE = methodNotAllowedHandler;

