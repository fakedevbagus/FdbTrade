/** Authenticated R1.2 adapter over the durable R0.8 research authority. */
import { z } from "zod";

import { requireSession } from "@/auth/guard";
import { getDatabase } from "@/db/client";
import { marketDataAuthority } from "@/data/historical/storeDir";
import { ApiError } from "@/http/errors";
import { withApi } from "@/http/handler";
import { jsonOk } from "@/http/responses";
import { parseJsonBody } from "@/http/validate";
import {
  RESEARCH_CONFIG_ID,
  RESEARCH_CONFIG_VERSION,
  RESEARCH_RUN_LIST_LIMIT,
} from "@/research/researchAuthority";
import { researchBacktestAuthority } from "@/research/storeDir";
import {
  SIGNAL_RULE_CONFIG_VERSION,
  SIGNAL_RULE_ID,
  SIGNAL_RULE_LOGIC_VERSION,
  SignalIntelligenceAuthority,
} from "@/signals/signalAuthority";

export const dynamic = "force-dynamic";

const researchRunRequestSchema = z
  .object({
    datasetId: z.string().min(1).max(128),
    createdAtUtc: z.iso.datetime({ offset: false, precision: 3 }),
  })
  .strict();

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

export const POST = withApi(async (request, { requestId }) => {
  await requireSession(request);
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].length > 0) {
    throw ApiError.validation("Research run submission accepts no query parameters.");
  }
  const body = await parseJsonBody(request, researchRunRequestSchema);
  const database = getDatabase();
  const dataset = database.prepare(`
    SELECT dataset_id FROM market_data_datasets WHERE dataset_id = ?
  `).get(body.datasetId);
  if (!dataset) throw ApiError.notFound("Dataset is not registered in the R0.6 authority.");

  const market = marketDataAuthority(database);
  const signalAuthority = new SignalIntelligenceAuthority(database, market);
  const signalRuleRegistered = signalAuthority.registerBaselineRule(body.createdAtUtc);
  const authority = researchBacktestAuthority(database);
  const researchConfigRegistered = authority.registerBaselineConfig(body.createdAtUtc);
  const recovery = authority.recover();
  if (recovery.corruptResults.length > 0) {
    throw ApiError.internal("Research authority recovery failed closed.");
  }

  const execution = authority.runDataset(body.datasetId, body.createdAtUtc);
  const run = authority.getRun(execution.authorityRunId);
  if (!run) throw ApiError.internal("Research run projection is unavailable.");

  return jsonOk(
    {
      schemaVersion: 1,
      authority: "sqlite-and-content-addressed-artifact",
      baseline: {
        configId: RESEARCH_CONFIG_ID,
        configVersion: RESEARCH_CONFIG_VERSION,
        signalRuleId: SIGNAL_RULE_ID,
        signalLogicVersion: SIGNAL_RULE_LOGIC_VERSION,
        signalConfigVersion: SIGNAL_RULE_CONFIG_VERSION,
        signalRuleRegistered,
        researchConfigRegistered,
      },
      recovery,
      executed: execution.executed,
      run,
      safety,
    },
    { requestId },
  );
});

export const GET = withApi(async (request, { requestId }) => {
  await requireSession(request);
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].length > 0) {
    throw ApiError.validation("Research run list accepts no query parameters.");
  }
  const database = getDatabase();
  const authority = researchBacktestAuthority(database);
  const datasets = marketDataAuthority(database).list().sort((left, right) =>
    right.createdAtUtc.localeCompare(left.createdAtUtc) ||
    left.datasetId.localeCompare(right.datasetId));

  return jsonOk(
    {
      schemaVersion: 1,
      authority: "sqlite-and-content-addressed-artifact",
      datasets,
      researchRuns: authority.listRuns(),
      ordering: "createdAtUtc desc, authorityRunId desc",
      limit: RESEARCH_RUN_LIST_LIMIT,
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
