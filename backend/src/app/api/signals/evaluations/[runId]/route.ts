/** Authenticated R1.1 detail projection for one durable R0.7 evaluation. */
import { requireSession } from "@/auth/guard";
import { getDatabase } from "@/db/client";
import { marketDataAuthority } from "@/data/historical/storeDir";
import { ApiError } from "@/http/errors";
import { withApi } from "@/http/handler";
import { jsonOk } from "@/http/responses";
import { SignalWorkbenchProjection } from "@/signals/signalWorkbench";

export const dynamic = "force-dynamic";

const RUN_ID_PATTERN = /^sir_[0-9a-f]{32}$/u;

const getHandler = withApi(async (request, { requestId }) => {
  await requireSession(request);
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].length > 0) {
    throw ApiError.validation("Signal evaluation detail accepts no query parameters.");
  }
  const runId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  if (!RUN_ID_PATTERN.test(runId)) {
    throw ApiError.notFound("Signal evaluation not found.");
  }
  const database = getDatabase();
  const projection = new SignalWorkbenchProjection(
    database,
    marketDataAuthority(database),
  );
  const run = projection.getRun(runId);
  if (!run) throw ApiError.notFound("Signal evaluation not found.");
  return jsonOk(
    {
      schemaVersion: 1,
      authority: "sqlite",
      run,
      safety: {
        uiAuthority: false,
        legacyScannerAuthoritative: false,
        researchAuthorityInvoked: false,
        riskPaperAuthorityInvoked: false,
        liveExecutionEnabled: false,
        providerOrderTransportEnabled: false,
      },
    },
    { requestId },
  );
});

interface RouteContext {
  params: Promise<{ runId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  void context;
  return getHandler(request);
}

const denied = withApi(async () => {
  throw ApiError.methodNotAllowed(["GET"]);
});

export const POST = denied;
export const PUT = denied;
export const PATCH = denied;
export const DELETE = denied;
