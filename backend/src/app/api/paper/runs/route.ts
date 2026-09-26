/** Authenticated R1.7 operator-confirmed adapter over the durable R0.9 authority. */
import { z } from "zod";

import { requireSession } from "@/auth/guard";
import { getDatabase } from "@/db/client";
import { marketDataAuthority } from "@/data/historical/storeDir";
import { ApiError } from "@/http/errors";
import { withApi } from "@/http/handler";
import { jsonOk } from "@/http/responses";
import { parseJsonBody } from "@/http/validate";
import {
  PaperInputResolutionAuthority,
  loadVerifiedPaperInputResolution,
} from "@/paper/paperInputResolutionAuthority";
import {
  RiskPaperAuthority,
  type PaperRunResult,
} from "@/paper/riskPaperAuthority";
import {
  DurablePaperRunProjection,
  type PaperRunProjection,
} from "@/paper/paperRunProjection";

export const dynamic = "force-dynamic";

const paperRunRequestSchema = z
  .object({
    inputResolutionId: z.string().regex(/^pir_[0-9a-f]{32}$/u),
    requestedQuantityUnits: z.number().positive().finite(),
    confirmation: z.literal("confirm-paper-run"),
  })
  .strict();

const safety = {
  paperOnly: true,
  explicitOperatorConfirmationRequired: true,
  automaticPaperExecutionEnabled: false,
  liveExecutionEnabled: false,
  demoExecutionEnabled: false,
  providerOrderTransportEnabled: false,
  externalProviderNetworkCallsEnabled: false,
  callerSuppliedCostOrConversionAccepted: false,
  approvedRiskRequired: true,
} as const;

function operatorState(
  run: PaperRunResult | PaperRunProjection,
): "pending" | "running" | "succeeded" | "blocked" | "rejected" | "failed" {
  return run.status === "blocked" && run.riskDecision?.outcome === "rejected"
    ? "rejected"
    : run.status;
}

function project(run: PaperRunResult | PaperRunProjection) {
  return { ...run, operatorState: operatorState(run) };
}

function assertRecovery(
  inputRecovery: ReturnType<PaperInputResolutionAuthority["recover"]>,
  paperRecovery: ReturnType<RiskPaperAuthority["recover"]>,
): void {
  if (inputRecovery.corruptRecords.length > 0) {
    throw ApiError.replayDetected("Paper input recovery found corrupt evidence.");
  }
  if (paperRecovery.corruptRecords.length > 0 || !paperRecovery.reconciliationOk) {
    throw ApiError.replayDetected("Paper ledger recovery or reconciliation failed.");
  }
}

export const POST = withApi(async (request, { requestId }) => {
  await requireSession(request);
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].length > 0) {
    throw ApiError.validation("Paper run confirmation accepts no query parameters.");
  }
  const body = await parseJsonBody(request, paperRunRequestSchema);
  const database = getDatabase();
  const market = marketDataAuthority(database);
  const inputs = new PaperInputResolutionAuthority(database, market);
  const inputRecovery = inputs.recover();
  if (inputRecovery.corruptRecords.length > 0) {
    throw ApiError.replayDetected("Paper input recovery found corrupt evidence.");
  }

  let resolved;
  try {
    resolved = loadVerifiedPaperInputResolution(database, market, body.inputResolutionId);
  } catch {
    const exists = database.prepare(`
      SELECT resolution_id FROM paper_input_resolutions WHERE resolution_id = ?
    `).get(body.inputResolutionId);
    if (!exists) throw ApiError.notFound("Verified paper input resolution not found.");
    throw ApiError.replayDetected("Paper input resolution verification failed.");
  }

  const authority = new RiskPaperAuthority(database, market);
  authority.registerBaseline(resolved.checkedAtUtc);
  const paperRecovery = authority.recover();
  assertRecovery(inputRecovery, paperRecovery);

  let run: PaperRunResult;
  try {
    run = authority.run({
      inputResolutionId: body.inputResolutionId,
      requestedQuantityUnits: body.requestedQuantityUnits,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("divergent authoritative request")) {
      throw ApiError.replayDetected("Paper run replay diverged from its durable request.");
    }
    throw error;
  }

  return jsonOk(
    {
      schemaVersion: 1,
      authority: "sqlite-risk-paper-authority",
      confirmation: {
        explicit: true,
        action: body.confirmation,
      },
      recovery: { inputs: inputRecovery, paper: paperRecovery },
      run: project(run),
      safety,
    },
    { requestId },
  );
});

export const GET = withApi(async (request, { requestId }) => {
  await requireSession(request);
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].length > 0) {
    throw ApiError.validation("Paper run list accepts no query parameters.");
  }
  const database = getDatabase();
  const market = marketDataAuthority(database);
  const authority = new RiskPaperAuthority(database, market);
  const projection = new DurablePaperRunProjection(database);
  const runs = projection.listRuns();
  const recovery = runs.length === 0
    ? {
        recoveredRuns: 0,
        verifiedDecisions: 0,
        verifiedOrders: 0,
        verifiedFills: 0,
        verifiedOutcomes: 0,
        reconciliationOk: true,
        corruptRecords: [],
      }
    : authority.recover();
  if (recovery.corruptRecords.length > 0 || !recovery.reconciliationOk) {
    throw ApiError.replayDetected("Paper ledger recovery or reconciliation failed.");
  }
  return jsonOk(
    {
      schemaVersion: 1,
      authority: "sqlite-risk-paper-authority",
      recovery,
      runs: projection.listRuns().map(project),
      ordering: "createdAtUtc desc, runId desc",
      safety,
    },
    { requestId },
  );
});

const denied = withApi(async () => {
  throw ApiError.methodNotAllowed(["GET", "POST"]);
});

export const PUT = denied;
export const PATCH = denied;
export const DELETE = denied;