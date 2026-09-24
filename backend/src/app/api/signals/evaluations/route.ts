/** R0.12 operator-triggered entry point for the durable R0.7 signal authority. */
import { z } from "zod";

import { requireSession } from "@/auth/guard";
import { utcNowIso } from "@/clock";
import { getDatabase } from "@/db/client";
import { marketDataAuthority } from "@/data/historical/storeDir";
import { ApiError } from "@/http/errors";
import { withApi } from "@/http/handler";
import { jsonOk } from "@/http/responses";
import { parseJsonBody } from "@/http/validate";
import {
  SIGNAL_RULE_CONFIG_VERSION,
  SIGNAL_RULE_ID,
  SIGNAL_RULE_LOGIC_VERSION,
  SignalIntelligenceAuthority,
} from "@/signals/signalAuthority";
import { SignalWorkbenchProjection } from "@/signals/signalWorkbench";

export const dynamic = "force-dynamic";

const evaluationRequestSchema = z
  .object({
    datasetId: z.string().min(1).max(128),
    assessedAtUtc: z.iso.datetime({ offset: false, precision: 3 }),
  })
  .strict();

export const POST = withApi(async (request, { requestId }) => {
  await requireSession(request);
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].length > 0) {
    throw ApiError.validation("Signal evaluation submission accepts no query parameters.");
  }
  const body = await parseJsonBody(request, evaluationRequestSchema);
  const database = getDatabase();

  const dataset = database.prepare(`
    SELECT dataset_id FROM market_data_datasets WHERE dataset_id = ?
  `).get(body.datasetId);
  if (!dataset) throw ApiError.notFound("Dataset is not registered in the R0.6 authority.");

  const authority = new SignalIntelligenceAuthority(
    database,
    marketDataAuthority(database),
  );
  const createdAtUtc = utcNowIso();
  authority.registerBaselineRule(createdAtUtc);
  const recovery = authority.recover();
  if (recovery.corruptEvidence.length > 0) {
    throw ApiError.internal("Signal authority recovery failed closed.");
  }
  const result = authority.evaluateDataset(
    body.datasetId,
    body.assessedAtUtc,
    createdAtUtc,
  );

  return jsonOk(
    {
      schemaVersion: 1,
      authority: "sqlite",
      rule: {
        ruleId: SIGNAL_RULE_ID,
        logicVersion: SIGNAL_RULE_LOGIC_VERSION,
        configVersion: SIGNAL_RULE_CONFIG_VERSION,
      },
      recovery,
      result,
      safety: {
        executionMode: "decision-support-only",
        liveExecutionEnabled: false,
        providerOrderTransportEnabled: false,
        credentialedProviderSelected: false,
        researchAuthorityInvoked: false,
        riskPaperAuthorityInvoked: false,
        uiAuthority: false,
      },
    },
    { requestId },
  );
});

export const GET = withApi(async (request, { requestId }) => {
  await requireSession(request);
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].length > 0) {
    throw ApiError.validation("Signal evaluation list accepts no query parameters.");
  }
  const database = getDatabase();
  const projection = new SignalWorkbenchProjection(
    database,
    marketDataAuthority(database),
  );
  return jsonOk(
    {
      schemaVersion: 1,
      authority: "sqlite",
      datasets: projection.listDatasets(),
      evaluations: projection.listRuns(),
      ordering: "assessedAtUtc desc, createdAtUtc desc, runId desc",
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

const denied = withApi(async () => {
  throw ApiError.methodNotAllowed(["GET", "POST"]);
});

export const PUT = denied;
export const PATCH = denied;
export const DELETE = denied;
