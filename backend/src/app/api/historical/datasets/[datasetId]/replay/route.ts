import { requireSession } from "@/auth/guard";
import { getDatabase } from "@/db/client";
import { marketDataAuthority } from "@/data/historical/storeDir";
import { loadHistoricalReplay } from "@/data/historical/replayLoader";
import { ApiError } from "@/http/errors";
import { withApi } from "@/http/handler";
import { jsonOk } from "@/http/responses";

export const dynamic = "force-dynamic";

export const GET = withApi(async (request, { requestId }) => {
  await requireSession(request);
  const datasetId = new URL(request.url).pathname.split("/").filter(Boolean).at(-2) ?? "";
  if (!datasetId || datasetId.length > 128) throw ApiError.validation("datasetId is required.");
  const replay = loadHistoricalReplay(marketDataAuthority(getDatabase()), datasetId);
  if (!replay.ok) throw ApiError.notFound("Historical dataset unavailable or integrity verification failed.");
  return jsonOk({ ...replay, candles: replay.candles }, { requestId });
});

const denied = withApi(async () => { throw ApiError.methodNotAllowed(["GET"]); });
export const POST = denied;
export const PUT = denied;
export const PATCH = denied;
export const DELETE = denied;
