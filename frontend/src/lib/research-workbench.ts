/** Strict frontend boundary for the projection-only R1.3 research workbench. */
import { z } from "zod";

import { BFF_API_URL } from "@/lib/dashboard";

const utcInstant = z.iso.datetime({ offset: false, precision: 3 });
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const authorityRunId = z.string().regex(/^rbr_[0-9a-f]{32}$/u);
const engineRunId = z.string().regex(/^btrun_[0-9a-f]{16}$/u);
const instrument = z.enum([
  "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD",
]);
const timeframe = z.enum(["15m", "1h", "4h"]);

const qualitySchema = z.object({
  accepted: z.number().int().nonnegative(),
  quarantined: z.number().int().nonnegative(),
  gaps: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  mode: z.enum(["fixture", "historical"]),
}).strict();

export const researchDatasetSchema = z.object({
  datasetId: z.string().min(1),
  providerId: z.string().min(1),
  instrument,
  timeframe,
  periodStartUtc: utcInstant,
  periodEndUtc: utcInstant,
  recordCount: z.number().int().positive(),
  checksum: digest,
  mode: z.enum(["fixture", "historical"]),
  quality: qualitySchema,
  qualityState: z.enum(["accepted", "quarantined", "gapped"]),
  freshnessState: z.enum(["fresh", "stale"]),
  latestBarCloseUtc: utcInstant,
  assessedAtUtc: utcInstant,
  createdAtUtc: utcInstant,
}).strict();

const datasetLineageSchema = z.object({
  datasetId: z.string().min(1),
  artifactDigest: digest,
  providerId: z.string().min(1),
  sourceMode: z.enum(["fixture", "historical"]),
  instrument,
  timeframe,
  recordCount: z.number().int().positive(),
  qualityState: z.enum(["accepted", "quarantined", "gapped"]),
}).strict();

const researchConfigSchema = z.object({
  configId: z.literal("baseline-historical-evaluation"),
  configVersion: z.literal("1.0.0"),
  configDigest: digest,
  signalRuleId: z.literal("authoritative-momentum-baseline"),
  signalLogicVersion: z.literal("1.0.0"),
  signalConfigVersion: z.literal("1.0.0"),
}).strict();

const costAssumptionsSchema = z.object({
  policyId: z.literal("realistic"),
  latencyBars: z.number().int().min(1),
  spreadPips: z.number().finite().nonnegative(),
  slippagePips: z.number().finite().nonnegative(),
  commissionPips: z.number().finite().nonnegative(),
  maxFillFraction: z.number().finite().positive().max(1),
  exitPriority: z.literal("stop-first"),
}).strict();

const metricsSchema = z.object({
  metricsEngineId: z.literal("backtest-metrics"),
  metricsEngineVersion: z.literal("1.0.0"),
  runId: engineRunId,
  initialEquity: z.number().finite().positive(),
  finalEquity: z.number().finite(),
  netReturn: z.number().finite().nullable(),
  cagr: z.number().finite().nullable(),
  maxDrawdown: z.number().finite().nonnegative(),
  maxDrawdownEquity: z.number().finite().nullable(),
  recoveryBars: z.number().int().nonnegative().nullable(),
  sharpe: z.number().finite().nullable(),
  sortino: z.number().finite().nullable(),
  calmar: z.number().finite().nullable(),
  closedTrades: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  expectancy: z.number().finite().nullable(),
  profitFactor: z.number().finite().nullable(),
  averageR: z.number().finite().nullable(),
  averageMfePips: z.number().finite().nullable(),
  averageMaePips: z.number().finite().nullable(),
  turnoverRatio: z.number().finite().nullable(),
  bars: z.number().int().nonnegative(),
}).strict();

const barsSchema = z.object({
  consumed: z.number().int().nonnegative(),
  firstBarOpenUtc: utcInstant.nullable(),
  lastBarOpenUtc: utcInstant.nullable(),
}).strict();

const subjectSchema = z.object({
  id: z.literal("authoritative-momentum-baseline"),
  version: z.literal("1.0.0"),
  configVersion: z.literal("1.0.0"),
}).strict();

const manifestSchema = z.object({
  runId: engineRunId,
  manifestVersion: z.literal(1),
  createdAtUtc: utcInstant,
  engine: z.object({
    engineId: z.literal("event-driven-backtest"),
    engineVersion: z.literal("1.0.0"),
    metricsEngineId: z.literal("backtest-metrics"),
    metricsEngineVersion: z.literal("1.0.0"),
  }).strict(),
  subject: subjectSchema,
  dataset: z.object({ datasetId: z.string().min(1), digest }).strict(),
  configHash: digest,
  costAssumptions: costAssumptionsSchema,
  seed: z.literal("r0.8-authoritative-baseline"),
  metrics: metricsSchema,
  artifacts: z.object({ equityDigest: digest, tradesDigest: digest }).strict(),
  bars: barsSchema,
}).strict();

const costBreakdownSchema = z.object({
  spreadPips: z.number().finite().nonnegative(),
  slippagePips: z.number().finite().nonnegative(),
  commissionPips: z.number().finite().nonnegative(),
}).strict();

const resultSchema = z.object({
  runId: engineRunId,
  engineId: z.literal("event-driven-backtest"),
  engineVersion: z.literal("1.0.0"),
  config: z.object({
    instrument,
    timeframe,
    periodStartUtc: utcInstant,
    periodEndUtc: utcInstant,
    initialEquity: z.number().finite().positive(),
    warmupBars: z.number().int().nonnegative(),
    fillPolicy: costAssumptionsSchema,
    subject: subjectSchema,
    seed: z.literal("r0.8-authoritative-baseline"),
  }).strict(),
  dataset: z.object({ datasetId: z.string().min(1), digest }).strict(),
  bars: barsSchema,
  events: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("intent_submitted"), atUtc: utcInstant, intentId: z.string().min(4) }).strict(),
    z.object({ type: z.literal("intent_rejected"), atUtc: utcInstant, intentId: z.string().min(4), reason: z.enum(["intent_pending", "position_open"]) }).strict(),
    z.object({ type: z.literal("intent_expired"), atUtc: utcInstant, intentId: z.string().min(4) }).strict(),
    z.object({ type: z.literal("position_opened"), atUtc: utcInstant, positionId: z.string().min(4) }).strict(),
    z.object({ type: z.literal("position_exited"), atUtc: utcInstant, positionId: z.string().min(4), reason: z.enum(["stop", "target", "end_of_run"]) }).strict(),
    z.object({ type: z.literal("equity_marked"), atUtc: utcInstant, equity: z.number().finite() }).strict(),
  ])),
  positions: z.array(z.object({
    positionId: z.string().min(4),
    intentId: z.string().min(4),
    instrument,
    timeframe,
    direction: z.enum(["long", "short"]),
    quantityUnits: z.number().finite().positive(),
    entry: z.object({ atUtc: utcInstant, price: z.number().finite().positive(), costs: costBreakdownSchema }).strict(),
    stopLoss: z.number().finite().positive(),
    takeProfit: z.number().finite().positive().nullable(),
    status: z.enum(["open", "closed"]),
    exit: z.object({
      atUtc: utcInstant,
      price: z.number().finite().positive(),
      reason: z.enum(["stop", "target", "end_of_run"]),
      costs: costBreakdownSchema,
    }).strict().nullable(),
    realizedPnl: z.number().finite(),
    mfePips: z.number().finite().nonnegative(),
    maePips: z.number().finite().nonnegative(),
  }).strict()),
  equityCurve: z.array(z.object({
    barOpenUtc: utcInstant,
    equity: z.number().finite(),
    realizedPnl: z.number().finite(),
    unrealizedPnl: z.number().finite(),
    openPositions: z.number().int().nonnegative(),
  }).strict()),
  finalState: z.object({
    equity: z.number().finite(),
    realizedPnl: z.number().finite(),
    unrealizedPnl: z.number().finite(),
    openPositionIds: z.array(z.string().min(4)),
    pendingIntentIds: z.array(z.string().min(4)),
    closedTrades: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const evidenceSchema = z.object({
  schemaVersion: z.literal(1),
  authorityRunId,
  status: z.enum(["succeeded", "blocked"]),
  reasons: z.array(z.string()),
  dataset: datasetLineageSchema,
  researchConfig: researchConfigSchema,
  empiricalEvidence: z.object({
    metrics: metricsSchema.nullable(),
    historicalOnly: z.literal(true),
    signalConfidenceCalibrated: z.literal(false),
    signalConfidenceValue: z.null(),
    modelPromotionEligible: z.literal(false),
    operationalOutcomeAuthority: z.literal(false),
  }).strict(),
  manifest: manifestSchema.nullable(),
  result: resultSchema.nullable(),
}).strict();

export const researchRunSchema = z.object({
  authorityRunId,
  status: z.enum(["pending", "running", "succeeded", "blocked", "failed"]),
  attempts: z.number().int().nonnegative(),
  createdAtUtc: utcInstant,
  updatedAtUtc: utcInstant,
  failureReason: z.string().nullable(),
  dataset: datasetLineageSchema,
  researchConfig: researchConfigSchema,
  artifact: z.object({
    resultId: z.string().regex(/^rres_[0-9a-f]{32}$/u),
    engineRunId: engineRunId.nullable(),
    digest,
    byteCount: z.number().int().positive(),
    summaryDigest: digest,
    createdAtUtc: utcInstant,
  }).strict().nullable(),
  evidence: evidenceSchema.nullable(),
}).strict().superRefine((run, context) => {
  const hasTerminalEvidence = run.status === "succeeded" || run.status === "blocked";
  if (hasTerminalEvidence !== (run.evidence !== null && run.artifact !== null)) {
    context.addIssue({ code: "custom", message: "Research terminal evidence is inconsistent." });
  }
  if (run.evidence !== null && run.evidence.status !== run.status) {
    context.addIssue({ code: "custom", message: "Research evidence status is inconsistent." });
  }
});

const safetySchema = z.object({
  historicalOnly: z.literal(true),
  signalConfidenceCalibrated: z.literal(false),
  modelPromotionEligible: z.literal(false),
  operationalOutcomeAuthority: z.literal(false),
  legacyBacktestAuthoritative: z.literal(false),
  riskPaperAuthorityInvoked: z.literal(false),
  liveExecutionEnabled: z.literal(false),
  providerOrderTransportEnabled: z.literal(false),
  credentialedProviderSelected: z.literal(false),
}).strict();

export const researchWorkbenchListSchema = z.object({
  schemaVersion: z.literal(1),
  authority: z.literal("sqlite-and-content-addressed-artifact"),
  datasets: z.array(researchDatasetSchema),
  researchRuns: z.object({
    total: z.number().int().nonnegative(),
    limit: z.literal(100),
    runs: z.array(researchRunSchema),
  }).strict(),
  ordering: z.literal("createdAtUtc desc, authorityRunId desc"),
  limit: z.literal(100),
  safety: safetySchema,
}).strict();

const researchWorkbenchDetailSchema = z.object({
  schemaVersion: z.literal(1),
  authority: z.literal("sqlite-and-content-addressed-artifact"),
  run: researchRunSchema,
  safety: safetySchema,
}).strict();

const submissionSchema = z.object({
  schemaVersion: z.literal(1),
  authority: z.literal("sqlite-and-content-addressed-artifact"),
  baseline: z.object({
    configId: z.literal("baseline-historical-evaluation"),
    configVersion: z.literal("1.0.0"),
    signalRuleId: z.literal("authoritative-momentum-baseline"),
    signalLogicVersion: z.literal("1.0.0"),
    signalConfigVersion: z.literal("1.0.0"),
    signalRuleRegistered: z.boolean(),
    researchConfigRegistered: z.boolean(),
  }).strict(),
  recovery: z.object({
    recoveredRuns: z.number().int().nonnegative(),
    verifiedResults: z.number().int().nonnegative(),
    corruptResults: z.array(z.string()),
    orphanArtifacts: z.number().int().nonnegative(),
  }).strict(),
  executed: z.boolean(),
  run: researchRunSchema,
  safety: safetySchema,
}).strict();

const submissionRequestSchema = z.object({
  datasetId: z.string().min(1).max(128),
  createdAtUtc: utcInstant,
}).strict();

export type ResearchDataset = z.infer<typeof researchDatasetSchema>;
export type ResearchRun = z.infer<typeof researchRunSchema>;
export type ResearchWorkbenchList = z.infer<typeof researchWorkbenchListSchema>;
export type ResearchSubmission = z.infer<typeof submissionSchema>;
export type ResearchResult<T> = { ok: true; data: T } | { ok: false; error: string };

export function isEligibleResearchDataset(dataset: ResearchDataset): boolean {
  return dataset.qualityState === "accepted" &&
    dataset.quality.quarantined === 0 &&
    dataset.quality.gaps === 0 &&
    dataset.quality.duplicates === 0;
}

export function eligibleResearchDatasets(datasets: readonly ResearchDataset[]): ResearchDataset[] {
  return datasets.filter(isEligibleResearchDataset);
}

async function readEnvelope<T>(
  response: Response,
  schema: z.ZodType<T>,
  schemaError: string,
): Promise<ResearchResult<T>> {
  let body: { ok?: boolean; data?: unknown; error?: { message?: unknown } };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return { ok: false, error: "Research service returned malformed JSON." };
  }
  if (response.status === 401) {
    return { ok: false, error: "Session expired. Sign in again before using research." };
  }
  if (response.status !== 200 || body.ok !== true) {
    return {
      ok: false,
      error: typeof body.error?.message === "string"
        ? body.error.message
        : `Backend returned HTTP ${response.status}.`,
    };
  }
  const parsed = schema.safeParse(body.data);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: schemaError };
}

export async function fetchResearchWorkbench(
  cookie?: string,
): Promise<ResearchResult<ResearchWorkbenchList>> {
  try {
    const response = await fetch(`${BFF_API_URL}/api/research/runs`, {
      headers: cookie ? { cookie } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    return await readEnvelope(
      response,
      researchWorkbenchListSchema,
      "Research workbench response failed schema validation.",
    );
  } catch {
    return { ok: false, error: "Research backend is unavailable." };
  }
}

export async function fetchResearchRun(
  runId: string,
  cookie?: string,
): Promise<ResearchResult<ResearchRun>> {
  if (!authorityRunId.safeParse(runId).success) {
    return { ok: false, error: "Research run id is invalid." };
  }
  try {
    const response = await fetch(`${BFF_API_URL}/api/research/runs/${encodeURIComponent(runId)}`, {
      headers: cookie ? { cookie } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const parsed = await readEnvelope(
      response,
      researchWorkbenchDetailSchema,
      "Research run detail failed schema validation.",
    );
    return parsed.ok ? { ok: true, data: parsed.data.run } : parsed;
  } catch {
    return { ok: false, error: "Research run detail is unavailable." };
  }
}

export async function submitResearchRun(
  payload: { datasetId: string; createdAtUtc: string },
): Promise<ResearchResult<ResearchSubmission>> {
  const request = submissionRequestSchema.safeParse(payload);
  if (!request.success) {
    return { ok: false, error: "Research run request failed schema validation." };
  }
  try {
    const response = await fetch("/api/research/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.data),
      cache: "no-store",
    });
    return await readEnvelope(
      response,
      submissionSchema,
      "Research run response failed schema validation.",
    );
  } catch {
    return { ok: false, error: "Research run submission could not reach the backend." };
  }
}
