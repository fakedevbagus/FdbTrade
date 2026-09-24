/** Authenticated R1.2 detail projection for one durable R0.8 research run. */
import { requireSession } from "@/auth/guard";
import { getDatabase } from "@/db/client";
import { ApiError } from "@/http/errors";
import { withApi } from "@/http/handler";
import { jsonOk } from "@/http/responses";
import { researchBacktestAuthority } from "@/research/storeDir";

export const dynamic = "force-dynamic";

const RUN_ID_PATTERN = /^rbr_[0-9a-f]{32}$/u;

const safety = {
  historicalOnly: true,
  signalConfidenceCalibrated: false,
  modelPromotionEligible: false,
  operationalOutcomeAuthority: false,
  legacyBacktestAuthoritative: false,
  riskPaperAuthorityInvoked: false,
  liveExecutionEnabled: false,
  providerOrderTransportEnabled: false,
  credentialedProviderSelected: false,
} as const;

const getHandler = withApi(async (request, { requestId }) => {
  await requireSession(request);
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].length > 0) {
    throw ApiError.validation("Research run detail accepts no query parameters.");
  }
  const runId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  if (!RUN_ID_PATTERN.test(runId)) {
    throw ApiError.notFound("Research run not found.");
  }
  const run = researchBacktestAuthority(getDatabase()).getRun(runId);
  if (!run) throw ApiError.notFound("Research run not found.");

  return jsonOk(
    {
      schemaVersion: 1,
      authority: "sqlite-and-content-addressed-artifact",
      run,
      safety,
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
