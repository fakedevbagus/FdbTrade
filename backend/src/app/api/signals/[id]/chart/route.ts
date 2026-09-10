/**
 * `GET /api/signals/[id]/chart` (P07-04) — chart bars + overlays.
 *
 * Query: asOfUtc (required, closed 1h bar). Path: decisionId.
 * Returns the last closed bars ending at the decision bar, the signal
 * marker pinned to its bar open time, entry/SL/TP level overlays and the
 * feature-context rows. Coordinates are market timestamps/prices from the
 * canonical candle data — never pixel guesses. 404 when unknown.
 */
import { z } from "zod";

import { requireSession } from "@/auth/guard";
import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { jsonOk } from "@/http/responses";
import { buildSignalChart } from "@/signals/pipeline";

export const dynamic = "force-dynamic";

const chartQuerySchema = z
  .object({
    asOfUtc: z.iso.datetime({ offset: false, precision: 3 }),
  })
  .strict();

const DECISION_ID_RE =
  /^ens_[A-Z0-9]+_(?:5m|15m|1h|4h|1d)_\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const getHandler = withApi(async (request, { requestId }) => {
  await requireSession(request);
  const url = new URL(request.url);
  // /api/signals/{id}/chart -> id is the segment before "chart".
  const segments = url.pathname.split("/").filter(Boolean);
  const id = decodeURIComponent(segments[segments.length - 2] ?? "");
  if (!DECISION_ID_RE.test(id)) {
    throw ApiError.notFound("Signal not found.");
  }
  const raw = Object.fromEntries(url.searchParams.entries());
  const query = chartQuerySchema.safeParse(raw);
  if (!query.success) {
    throw ApiError.validation(
      "Query must contain exactly asOfUtc (UTC ISO instant, ms precision).",
    );
  }
  const chart = await buildSignalChart({ asOfUtc: query.data.asOfUtc }, id);
  if (chart === null) {
    throw ApiError.notFound("Signal chart not found at the requested bar.");
  }
  return jsonOk(chart, { requestId });
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  void context;
  return getHandler(request);
}

const methodNotAllowedHandler = withApi(async () => {
  throw ApiError.methodNotAllowed(["GET"]);
});

export const POST = methodNotAllowedHandler;
export const PUT = methodNotAllowedHandler;
export const PATCH = methodNotAllowedHandler;
export const DELETE = methodNotAllowedHandler;
