/**
 * `GET /api/dashboard` (P07-01) — private command-center snapshot.
 *
 * Query contract (schema-validated at the boundary):
 *   asOfUtc (required) — open time (UTC, ms precision, 1h-aligned) of the
 *   last closed bar the snapshot is evaluated from. The pipeline is fully
 *   deterministic given this input; the client (not the server) owns the
 *   wall-clock choice, so responses are reproducible and cache-irrelevant.
 *   pairs (optional) — comma-separated configured seven-major provider pairs
 *   (M47 pair filter). Unknown, repeated or non-configured pairs fail closed;
 *   the response order follows the configured pair order, never request order.
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
import { SEVEN_MAJOR_CONFIG, SEVEN_MAJOR_PAIRS } from "@/runtime/sevenMajors";

export const dynamic = "force-dynamic";

/**
 * Provider pair ids are external identifiers (`EUR_USD`); domain contracts stay
 * canonical (`EURUSD`). Only configured seven-major pairs are selectable — an
 * unknown pair fails closed instead of silently widening the universe.
 */
const sevenMajorPairQuery = z.string().refine(
  (value): value is (typeof SEVEN_MAJOR_PAIRS)[number] =>
    (SEVEN_MAJOR_PAIRS as readonly string[]).includes(value),
  "pairs must list configured seven-major provider pairs (e.g. EUR_USD)",
);

const dashboardQuerySchema = z
  .object({
    asOfUtc: z.iso.datetime({ offset: false, precision: 3 }),
    /** Optional pair filter: comma-separated configured provider pairs. */
    pairs: z
      .string()
      .transform((value) =>
        value
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part.length > 0),
      )
      .pipe(z.array(sevenMajorPairQuery).min(1).max(SEVEN_MAJOR_PAIRS.length))
      .refine((pairs) => new Set(pairs).size === pairs.length, {
        message: "pairs must not repeat",
      })
      .optional(),
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
      "Query must contain exactly asOfUtc (UTC ISO instant, ms precision) and optionally pairs (comma-separated configured provider pairs).",
      query.error.issues.map((issue) => ({
        path: issue.path.map(String).join(".") || "(root)",
        message: issue.message,
        code: issue.code,
      })),
    );
  }
  // Filter order follows the configured pair order, never request order.
  const requestedPairs = query.data.pairs;
  const selected = requestedPairs
    ? SEVEN_MAJOR_CONFIG.filter((entry) => requestedPairs.includes(entry.pair))
    : null;
  let snapshot;
  try {
    snapshot = await buildDashboardSnapshot({
      asOfUtc: query.data.asOfUtc,
      ...(selected
        ? { instruments: selected.map((entry) => entry.canonicalInstrument) }
        : {}),
    });
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
