/**
 * `GET /api/signals/scanner` (P07-02) — instrument/timeframe scanner.
 *
 * Query contract (validated at the boundary, fail closed):
 *   asOfUtc (required)  — closed 1h bar the scan is evaluated from;
 *   direction|regime|minConfidence|minEdgePips|freshOnly|maxAgeBars|sort
 *                       — the P07-02 filter set (scannerQuerySchema).
 *
 * Deterministic: identical query -> byte-identical rows (URL state can be
 * reproduced from the canonical params echoed in the response). No order
 * button exists anywhere in this API — read-only intelligence (ADR-0005).
 */
import { z } from "zod";

import { requireSession } from "@/auth/guard";
import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { jsonOk } from "@/http/responses";
import { buildScannerView } from "@/signals/pipeline";
import { scannerQuerySchema } from "@/signals/scanner";

export const dynamic = "force-dynamic";

const scannerRouteQuerySchema = scannerQuerySchema.extend({
  asOfUtc: z.iso.datetime({ offset: false, precision: 3 }),
});

export const GET = withApi(async (request, { requestId }) => {
  await requireSession(request);
  const url = new URL(request.url);
  const raw: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (raw[key] !== undefined) {
      throw ApiError.validation(`Duplicate query parameter: ${key}`);
    }
    raw[key] = value;
  }
  const parsed = scannerRouteQuerySchema.safeParse(raw);
  if (!parsed.success) {
    throw ApiError.validation(
      "Scanner query failed schema validation.",
      parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join(".") || "(root)",
        message: issue.message,
        code: issue.code,
      })),
    );
  }
  const { asOfUtc, ...filters } = parsed.data;
  try {
    const view = await buildScannerView({ asOfUtc }, filters);
    return jsonOk(view, { requestId });
  } catch (error) {
    throw ApiError.validation(
      error instanceof Error ? error.message : "Invalid scanner request.",
    );
  }
});

const methodNotAllowedHandler = withApi(async () => {
  throw ApiError.methodNotAllowed(["GET"]);
});

export const POST = methodNotAllowedHandler;
export const PUT = methodNotAllowedHandler;
export const PATCH = methodNotAllowedHandler;
export const DELETE = methodNotAllowedHandler;
