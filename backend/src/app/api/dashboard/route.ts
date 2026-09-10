/**
 * `GET /api/dashboard` (P07-01) — private command-center snapshot.
 *
 * Query contract (schema-validated at the boundary):
 *   asOfUtc (required) — open time (UTC, ms precision, 1h-aligned) of the
 *   last closed bar the snapshot is evaluated from. The pipeline is fully
 *   deterministic given this input; the client (not the server) owns the
 *   wall-clock choice, so responses are reproducible and cache-irrelevant.
 *
 * Fail closed: malformed query -> structured 400 VALIDATION_ERROR. The
 * route calls requireSession (private area) and the read-only signal
 * pipeline — it NEVER touches any execution path (ADR-0005).
 */
import { z } from "zod";

import { requireSession } from "@/auth/guard";
import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { jsonOk } from "@/http/responses";
import { buildDashboardSnapshot } from "@/signals/pipeline";

export const dynamic = "force-dynamic";

const dashboardQuerySchema = z
  .object({
    asOfUtc: z.iso.datetime({ offset: false, precision: 3 }),
  })
  .strict();

export const GET = withApi(async (request, { requestId }) => {
  await requireSession(request);
  const url = new URL(request.url);
  let raw: unknown;
  try {
    raw = Object.fromEntries(url.searchParams.entries());
  } catch {
    raw = {};
  }
  const query = dashboardQuerySchema.safeParse(raw);
  if (!query.success) {
    throw ApiError.validation(
      "Query must contain exactly asOfUtc (UTC ISO instant, ms precision).",
      query.error.issues.map((issue) => ({
        path: issue.path.map(String).join(".") || "(root)",
        message: issue.message,
        code: issue.code,
      })),
    );
  }
  let snapshot;
  try {
    snapshot = await buildDashboardSnapshot({ asOfUtc: query.data.asOfUtc });
  } catch (error) {
    // Pipeline contract violations (misalignment, unknown instruments...) are
    // client-input errors: surface as 400 with the deterministic message.
    throw ApiError.validation(
      error instanceof Error ? error.message : "Invalid asOfUtc for the snapshot.",
    );
  }
  return jsonOk(snapshot, { requestId });
});

const methodNotAllowedHandler = withApi(async () => {
  throw ApiError.methodNotAllowed(["GET"]);
});

export const POST = methodNotAllowedHandler;
export const PUT = methodNotAllowedHandler;
export const PATCH = methodNotAllowedHandler;
export const DELETE = methodNotAllowedHandler;
