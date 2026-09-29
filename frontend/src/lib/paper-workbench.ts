/** Strict projection-only R1.8 boundary over the durable R1.7 paper API. */
import { z } from "zod";

import { BFF_API_URL } from "@/lib/dashboard";

const utc = z.iso.datetime({ offset: false, precision: 3 });
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const runId = z.string().regex(/^rpr_[0-9a-f]{32}$/u);
const resolutionId = z.string().regex(/^pir_[0-9a-f]{32}$/u);
const instrument = z.enum(["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD"]);
const timeframe = z.enum(["15m", "1h", "4h"]);
const riskState = z.enum(["green", "yellow", "orange", "red", "kill"]);

const resolutionSchema = z.object({
  schemaVersion: z.literal(1), resolutionId, signalId: z.string().min(4), instrument, timeframe,
  eventTimeUtc: utc, checkedAtUtc: utc,
  signalDataset: z.object({ datasetId: z.string().min(1), artifactDigest: digest, providerId: z.string().min(1) }).strict(),
  executionDataset: z.object({ datasetId: z.string().min(1), artifactDigest: digest, providerId: z.string().min(1) }).strict(),
  config: z.object({ configId: z.string().min(1), configVersion: z.string().min(1), configDigest: digest }).strict(),
  costs: z.object({
    observedSpreadPips: z.number().nonnegative(), estimatedSlippagePips: z.number().nonnegative(),
    source: z.literal("registered-baseline-assumption-no-provider-observation"), providerObservation: z.literal(false),
  }).strict(),
  conversion: z.object({
    quoteCurrency: z.string().length(3), accountCurrency: z.literal("USD"), conversionRate: z.number().positive(),
    rateAtUtc: utc, rateSource: z.string().min(1), method: z.enum(["identity", "inverse"]),
    sourceInstrument: instrument, sourceDatasetId: z.string().min(1), sourceArtifactDigest: digest,
    sourceBarDigest: digest, crossInstruments: z.tuple([]),
  }).strict(),
  resolutionDigest: digest,
}).strict();

const signalSchema = z.object({
  signalId: z.string().min(4), instrument, timeframe, eventTimeUtc: utc,
  direction: z.enum(["long", "short"]), strategyId: z.string().min(1), strategyVersion: z.string().min(1),
  configVersion: z.string().min(1), entryType: z.enum(["market", "stop", "limit"]),
  entryPrice: z.number().nullable(), referencePrice: z.number(), stopLoss: z.number(), takeProfit: z.number().nullable(),
  expiresAtUtc: utc, confidence: z.number(), reasonCodes: z.array(z.string()),
  inputs: z.record(z.string(), z.union([z.number(), z.boolean(), z.null()])), snapshotHash: digest,
  signalContractVersion: z.literal(1),
}).strict();

const activeCandidateSchema = z.object({ signal: signalSchema, lifecycleState: z.literal("identified"), resolution: resolutionSchema }).strict();
const riskStateSchema = z.object({
  eventId: z.string().min(1), sequenceNo: z.number().int().positive(), state: riskState,
  overrideId: z.string().nullable(), effectiveAtUtc: utc,
}).strict();

const riskDecisionSchema = z.object({
  decisionId: z.string().min(1), riskEngineId: z.string().min(1), riskEngineVersion: z.string().min(1),
  riskConfigVersion: z.string().min(1), checkedAtUtc: utc, intentId: z.string().min(1), signalId: z.string().min(1),
  strategyId: z.string().min(1), instrument, direction: z.enum(["long", "short"]),
  outcome: z.enum(["approved", "rejected"]), sizedQuantityUnits: z.number().nonnegative(),
  requestedQuantityUnits: z.number().positive(), sizeAdjusted: z.boolean(), riskAmountAccount: z.number().nonnegative(),
  riskFractionUsed: z.number().nonnegative(), reasons: z.array(z.string()), riskState,
  utilization: z.object({ portfolioHeatRatio: z.number().nonnegative(), dailyLossRatio: z.number().nonnegative(), weeklyDrawdownRatio: z.number().nonnegative() }).strict(),
  requestDigest: z.string().min(1), activeOverrideId: z.string().nullable(),
}).strict();

const paperOrderSchema = z.object({
  orderId: z.string().min(1), intentId: z.string().min(1), signalId: z.string().min(1), strategyId: z.string().min(1),
  strategyVersion: z.string().min(1), configVersion: z.string().min(1), snapshotHash: digest, instrument, timeframe,
  direction: z.enum(["long", "short"]), orderType: z.enum(["market", "stop", "limit"]), quantityUnits: z.number().positive(),
  entryPrice: z.number().nullable(), stopLoss: z.number(), takeProfit: z.number().nullable(), referencePrice: z.number(),
  createdAtUtc: utc, expiresAtUtc: utc, latencyBars: z.number().int().positive(), state: z.string().min(1),
}).strict();

const fillSchema = z.object({
  fillId: z.string().min(1), orderId: z.string().min(1), seq: z.number().int().positive(), side: z.enum(["entry", "exit"]),
  instrument, direction: z.enum(["long", "short"]), atUtc: utc, barIndex: z.number().int().nonnegative(),
  triggerPrice: z.number().positive(), price: z.number().positive(), quantityUnits: z.number().positive(),
  costs: z.object({ spreadPips: z.number().nonnegative(), slippagePips: z.number().nonnegative(), commissionPips: z.number().nonnegative() }).strict(),
  remainingQuantityUnits: z.number().nonnegative(),
}).strict();

const runSchema = z.object({
  runId, status: z.enum(["pending", "running", "succeeded", "blocked", "failed"]),
  operatorState: z.enum(["pending", "running", "succeeded", "blocked", "rejected", "failed"]),
  executed: z.boolean(), riskDecision: riskDecisionSchema.nullable(), order: paperOrderSchema.nullable(),
  outcome: z.record(z.string(), z.unknown()).nullable(), reason: z.string().nullable(), inputResolutionId: resolutionId,
  requestedQuantityUnits: z.number().positive(), fills: z.array(fillSchema),
  positionEvents: z.array(z.record(z.string(), z.unknown())), reconciliation: z.record(z.string(), z.unknown()).nullable(),
}).strict();

const safetySchema = z.object({
  paperOnly: z.literal(true), explicitOperatorConfirmationRequired: z.literal(true), automaticPaperExecutionEnabled: z.literal(false),
  liveExecutionEnabled: z.literal(false), demoExecutionEnabled: z.literal(false), providerOrderTransportEnabled: z.literal(false),
  externalProviderNetworkCallsEnabled: z.literal(false), callerSuppliedCostOrConversionAccepted: z.literal(false),
  approvedRiskRequired: z.literal(true), projectionOnly: z.literal(true),
}).strict();

export const paperWorkbenchSchema = z.object({
  schemaVersion: z.literal(1), authority: z.literal("sqlite-risk-paper-authority"), recovery: z.record(z.string(), z.unknown()),
  activeCandidate: activeCandidateSchema.nullable(), riskState: riskStateSchema.nullable(), runs: z.array(runSchema),
  ordering: z.literal("createdAtUtc desc, runId desc"), safety: safetySchema,
}).strict();

const detailSchema = z.object({
  schemaVersion: z.literal(1), authority: z.literal("sqlite-risk-paper-authority"), recovery: z.record(z.string(), z.unknown()),
  run: runSchema, safety: safetySchema.omit({ explicitOperatorConfirmationRequired: true, externalProviderNetworkCallsEnabled: true, callerSuppliedCostOrConversionAccepted: true, approvedRiskRequired: true }).extend({ projectionOnly: z.literal(true) }),
}).strict();

const submissionSchema = z.object({
  schemaVersion: z.literal(1), authority: z.literal("sqlite-risk-paper-authority"), confirmation: z.object({ explicit: z.literal(true), action: z.literal("confirm-paper-run") }).strict(),
  recovery: z.record(z.string(), z.unknown()), run: z.object({ runId, status: z.enum(["succeeded", "blocked", "failed"]), operatorState: z.enum(["succeeded", "blocked", "rejected", "failed"]), executed: z.boolean() }).passthrough(),
  safety: z.object({ paperOnly: z.literal(true), explicitOperatorConfirmationRequired: z.literal(true), automaticPaperExecutionEnabled: z.literal(false), liveExecutionEnabled: z.literal(false), demoExecutionEnabled: z.literal(false), providerOrderTransportEnabled: z.literal(false), externalProviderNetworkCallsEnabled: z.literal(false), callerSuppliedCostOrConversionAccepted: z.literal(false), approvedRiskRequired: z.literal(true) }).strict(),
}).strict();

export type PaperWorkbench = z.infer<typeof paperWorkbenchSchema>;
export type PaperRun = z.infer<typeof runSchema>;
export type ActivePaperCandidate = z.infer<typeof activeCandidateSchema>;
export type PaperResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function envelope<T>(response: Response, schema: z.ZodType<T>): Promise<PaperResult<T>> {
  let body: { ok?: boolean; data?: unknown; error?: { message?: unknown } };
  try { body = (await response.json()) as typeof body; }
  catch { return { ok: false, error: "Paper backend returned malformed JSON." }; }
  if (response.status === 401) return { ok: false, error: "Session expired. Sign in again before using the private paper workbench." };
  if (response.status !== 200 || body.ok !== true) return { ok: false, error: typeof body.error?.message === "string" ? body.error.message : `Backend returned HTTP ${response.status}.` };
  const parsed = schema.safeParse(body.data);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: "Paper response failed closed schema validation." };
}

export async function fetchPaperWorkbench(cookie?: string): Promise<PaperResult<PaperWorkbench>> {
  try {
    const response = await fetch(`${BFF_API_URL}/api/paper/runs`, { headers: cookie ? { cookie } : {}, cache: "no-store", signal: AbortSignal.timeout(10_000) });
    return await envelope(response, paperWorkbenchSchema);
  } catch { return { ok: false, error: "Paper backend is unavailable." }; }
}

export async function fetchPaperRun(id: string, cookie?: string): Promise<PaperResult<PaperRun>> {
  if (!runId.safeParse(id).success) return { ok: false, error: "Paper run id is invalid." };
  try {
    const response = await fetch(`${BFF_API_URL}/api/paper/runs/${encodeURIComponent(id)}`, { headers: cookie ? { cookie } : {}, cache: "no-store", signal: AbortSignal.timeout(10_000) });
    const result = await envelope(response, detailSchema);
    return result.ok ? { ok: true, data: result.data.run } : result;
  } catch { return { ok: false, error: "Paper run detail is unavailable." }; }
}

export async function confirmPaperRun(inputResolutionId: string, requestedQuantityUnits: number): Promise<PaperResult<z.infer<typeof submissionSchema>>> {
  const request = z.object({ inputResolutionId: resolutionId, requestedQuantityUnits: z.number().positive().finite(), confirmation: z.literal("confirm-paper-run") }).strict().safeParse({ inputResolutionId, requestedQuantityUnits, confirmation: "confirm-paper-run" });
  if (!request.success) return { ok: false, error: "Paper confirmation request is invalid." };
  try {
    const response = await fetch("/api/paper/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request.data), cache: "no-store" });
    return await envelope(response, submissionSchema);
  } catch { return { ok: false, error: "Paper confirmation could not reach the backend." }; }
}
