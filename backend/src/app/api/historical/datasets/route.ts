import { z } from "zod";

import { requireSession } from "@/auth/guard";
import { getDatabase } from "@/db/client";
import { confirmImport, previewImport } from "@/data/historical/importService";
import { marketDataAuthority } from "@/data/historical/storeDir";
import { listDatasets } from "@/data/historical/datasetRegistry";
import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { jsonOk } from "@/http/responses";
import { parseJsonBody } from "@/http/validate";

const importSchema = z.object({
  csvText: z.string().min(1).max(10 * 1024 * 1024), instrument: z.string().min(1).max(32),
  timeframe: z.enum(["5m", "15m", "1h", "4h", "1d"]), providerId: z.string().min(1).max(128),
  license: z.object({ status: z.enum(["verified", "unverified", "synthetic"]), source: z.string().min(1), evidenceUrl: z.string().url().nullable(), note: z.string() }).strict(),
  createdAtUtc: z.string().datetime({ offset: true }),
  confirm: z.boolean().default(false),
}).strict();

export const POST = withApi(async (request, { requestId }) => {
  await requireSession(request);
  try {
    const body = await parseJsonBody(request, importSchema, { maxBodyBytes: 10 * 1024 * 1024 });
    const preview = previewImport(body);
    if (!body.confirm) {
      return jsonOk({
        approved: false, mode: "historical",
        preview: { manifest: preview.manifest, summary: preview.summary, parseErrors: preview.parseErrors, quality: preview.quality },
      }, { requestId });
    }
    const stored = confirmImport(marketDataAuthority(getDatabase()), preview);
    return jsonOk({ approved: true, manifest: stored.manifest, quality: stored.quality, mode: "historical" }, { requestId });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw ApiError.validation(error instanceof Error ? error.message : "Historical dataset registration failed.");
  }
});
export const GET = withApi(async (request, { requestId }) => {
  await requireSession(request);
  return jsonOk({ datasets: listDatasets(marketDataAuthority(getDatabase())), mode: "historical" }, { requestId });
});
const denied = withApi(async () => { throw ApiError.methodNotAllowed(["GET", "POST"]); });
export const PUT = denied;
export const PATCH = denied;
export const DELETE = denied;
