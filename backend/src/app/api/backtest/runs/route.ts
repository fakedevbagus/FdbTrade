/**
 * `POST /api/backtest/runs` (P08-05) — execute a backtest and persist its
 * run manifest + artifacts (idempotent). `GET` lists stored run manifests
 * (read-only). Session-guarded; the body is validated against the strict
 * request schema (fail closed). No optimization surface: one run per call,
 * no parameter sweeps.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { requireSession } from "@/auth/guard";
import { withApi } from "@/http/handler";
import { ApiError } from "@/http/errors";
import { jsonOk } from "@/http/responses";
import { parseJsonBody } from "@/http/validate";
import { executeAndStoreRun } from "@/backtest/api";
import { backtestRunRequestSchema } from "@/backtest/apiSchema";
import { RUN_STORE_FORMAT_VERSION } from "@/backtest/runStore";
import { RUN_STORE_DIR } from "@/backtest/storeDir";

export const dynamic = "force-dynamic";

export const POST = withApi(async (request, { requestId }) => {
  await requireSession(request);
  const body = await parseJsonBody(request, backtestRunRequestSchema);
  try {
    const response = await executeAndStoreRun(body, RUN_STORE_DIR);
    return jsonOk(response, { requestId });
  } catch (error) {
    throw ApiError.validation(
      error instanceof Error ? error.message : "Backtest run failed.",
    );
  }
});

const methodNotAllowed = withApi(async () => {
  throw ApiError.methodNotAllowed(["POST"]);
});

export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

const getHandler = withApi(async (_request, { requestId }) => {
  await requireSession(_request);
  if (!existsSync(RUN_STORE_DIR)) {
    return jsonOk({ runs: [], formatVersion: RUN_STORE_FORMAT_VERSION }, { requestId });
  }
  const files = readdirSync(RUN_STORE_DIR).filter((f) => f.endsWith(".json"));
  const runs = [];
  for (const file of files.sort()) {
    try {
      const stored = JSON.parse(
        readFileSync(path.join(RUN_STORE_DIR, file), "utf8"),
      ) as { manifest: unknown };
      runs.push(stored.manifest);
    } catch {
      // Unreadable entries are skipped from the listing (fail soft here;
      // the detail endpoint fails closed with an explicit reason).
    }
  }
  return jsonOk({ runs, formatVersion: RUN_STORE_FORMAT_VERSION }, { requestId });
});

export async function GET(request: Request): Promise<Response> {
  return getHandler(request);
}
