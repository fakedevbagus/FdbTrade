/** Authenticated R1.7 projection for one durable R0.9 paper run. */
import { requireSession } from "@/auth/guard";
import { getDatabase } from "@/db/client";
import { marketDataAuthority } from "@/data/historical/storeDir";
import { ApiError } from "@/http/errors";
import { withApi } from "@/http/handler";
import { jsonOk } from "@/http/responses";
import { PaperInputResolutionAuthority } from "@/paper/paperInputResolutionAuthority";
import { DurablePaperWorkbenchProjection } from "@/paper/paperWorkbenchProjection";
import { RiskPaperAuthority } from "@/paper/riskPaperAuthority";

export const dynamic = "force-dynamic";

const RUN_ID_PATTERN = /^rpr_[0-9a-f]{32}$/u;

const safety = {
  paperOnly: true,
  projectionOnly: true,
  liveExecutionEnabled: false,
  demoExecutionEnabled: false,
  providerOrderTransportEnabled: false,
  automaticPaperExecutionEnabled: false,
} as const;

const getHandler = withApi(async (request, { requestId }) => {
  await requireSession(request);
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].length > 0) {
    throw ApiError.validation("Paper run detail accepts no query parameters.");
  }
  const runId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  if (!RUN_ID_PATTERN.test(runId)) throw ApiError.notFound("Paper run not found.");

  const database = getDatabase();
  const market = marketDataAuthority(database);
  const inputs = new PaperInputResolutionAuthority(database, market);
  const inputRecovery = inputs.recover();
  if (inputRecovery.corruptRecords.length > 0) {
    throw ApiError.replayDetected("Paper input recovery found corrupt evidence.");
  }
  const authority = new RiskPaperAuthority(database, market);
  const projection = new DurablePaperWorkbenchProjection(database);
  if (!projection.getRun(runId)) throw ApiError.notFound("Paper run not found.");
  const recovery = authority.recover();
  if (recovery.corruptRecords.length > 0 || !recovery.reconciliationOk) {
    throw ApiError.replayDetected("Paper ledger recovery or reconciliation failed.");
  }
  const run = projection.getRun(runId);
  if (!run) throw ApiError.notFound("Paper run not found.");
  const operatorState =
    run.status === "blocked" && run.riskDecision?.outcome === "rejected"
      ? "rejected"
      : run.status;

  return jsonOk(
    {
      schemaVersion: 1,
      authority: "sqlite-risk-paper-authority",
      recovery: { inputs: inputRecovery, paper: recovery },
      run: { ...run, operatorState },
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