/**
 * `GET /api/backtest/runs/[runId]` (P08-05) — reopen a stored run.
 * Full attribution is verified on load (config hash, dataset digest,
 * equity/trade digests, engine identity, strict schema revalidation);
 * anything less fails closed with an explicit reason. Read-only.
 */
import { requireSession } from "@/auth/guard";
import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { jsonOk } from "@/http/responses";
import { metricsOfRun, reopenRun } from "@/backtest/api";
import { RUN_STORE_DIR } from "@/backtest/storeDir";

export const dynamic = "force-dynamic";

const RUN_ID_RE = /^btrun_[0-9a-f]{16}$/;

const getHandler = withApi(async (request, { requestId }) => {
  await requireSession(request);
  const url = new URL(request.url);
  const runId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  if (!RUN_ID_RE.test(runId)) {
    throw ApiError.notFound("Run not found.");
  }
  const loaded = reopenRun(RUN_STORE_DIR, runId);
  if (!loaded.ok) {
    throw ApiError.notFound(loaded.reason);
  }
  const metrics = metricsOfRun(loaded.run);
  return jsonOk(
    { runId, manifest: loaded.run.manifest, metrics, found: true },
    { requestId },
  );
});

export async function GET(request: Request): Promise<Response> {
  return getHandler(request);
}

const methodNotAllowed = withApi(async () => {
  throw ApiError.methodNotAllowed(["GET"]);
});

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
