import { z } from "zod";

import { requireSession } from "@/auth/guard";
import { previewImport } from "@/data/historical/importService";
import { APPROVED_MARKET_INSTRUMENTS, APPROVED_MARKET_TIMEFRAMES } from "@/data/marketAuthority";
import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { jsonOk } from "@/http/responses";
import { parseJsonBody } from "@/http/validate";

const requestSchema = z.object({
  csvText: z.string().min(1).max(10 * 1024 * 1024),
  instrument: z.enum(APPROVED_MARKET_INSTRUMENTS),
  timeframe: z.enum(APPROVED_MARKET_TIMEFRAMES),
  providerId: z.string().min(1).max(128),
  license: z.object({ status: z.enum(["verified", "unverified", "synthetic"]), source: z.string().min(1), evidenceUrl: z.string().url().nullable(), note: z.string() }).strict(),
  createdAtUtc: z.string().datetime({ offset: true }),
}).strict();

export const POST = withApi(async (request, { requestId }) => {
  await requireSession(request);
  try {
    const body = await parseJsonBody(request, requestSchema, { maxBodyBytes: 10 * 1024 * 1024 });
    const preview = previewImport(body);
    return jsonOk({ ...preview, candles: undefined }, { requestId });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw ApiError.validation(error instanceof Error ? error.message : "Historical import preview failed.");
  }
});

const denied = withApi(async () => { throw ApiError.methodNotAllowed(["POST"]); });
export const GET = denied;
export const PUT = denied;
export const PATCH = denied;
export const DELETE = denied;
