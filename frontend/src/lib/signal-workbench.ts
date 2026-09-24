/** Strict frontend boundary for the authoritative R1.1 signal workbench. */
import { z } from "zod";

import { BFF_API_URL } from "@/lib/dashboard";

const utcInstant = z.iso.datetime({ offset: false, precision: 3 });
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const runId = z.string().regex(/^sir_[0-9a-f]{32}$/u);

export const workbenchDatasetSchema = z.object({
  datasetId: z.string().min(1),
  providerId: z.string().min(1),
  instrument: z.enum(["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD"]),
  timeframe: z.enum(["15m", "1h", "4h"]),
  periodStartUtc: utcInstant,
  periodEndUtc: utcInstant,
  recordCount: z.number().int().positive(),
  checksum: digest,
  mode: z.enum(["fixture", "historical"]),
  quality: z.object({
    accepted: z.number().int().nonnegative(),
    quarantined: z.number().int().nonnegative(),
    gaps: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    mode: z.enum(["fixture", "historical"]),
  }).strict(),
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
  instrument: z.enum(["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD"]),
  timeframe: z.enum(["15m", "1h", "4h"]),
  recordCount: z.number().int().positive(),
  qualityState: z.enum(["accepted", "quarantined", "gapped"]),
  freshnessState: z.enum(["fresh", "stale"]),
  latestBarCloseUtc: utcInstant,
  assessedAtUtc: utcInstant,
}).strict();

const ruleLineageSchema = z.object({
  ruleId: z.literal("authoritative-momentum-baseline"),
  logicVersion: z.string().min(1),
  configVersion: z.string().min(1),
  configDigest: digest,
}).strict();

const signalSchema = z.object({
  signalId: z.string().min(1),
  instrument: z.string().min(1),
  timeframe: z.enum(["15m", "1h", "4h"]),
  eventTimeUtc: utcInstant,
  direction: z.enum(["long", "short"]),
  strategyId: z.string().min(1),
  strategyVersion: z.string().min(1),
  configVersion: z.string().min(1),
  entryType: z.enum(["market", "stop", "limit"]),
  entryPrice: z.number().nullable(),
  referencePrice: z.number(),
  stopLoss: z.number(),
  takeProfit: z.number().nullable(),
  expiresAtUtc: utcInstant,
  confidence: z.number().min(0).max(1),
  reasonCodes: z.array(z.string()),
  inputs: z.record(z.string(), z.union([z.number(), z.boolean(), z.null()])),
  snapshotHash: digest,
  signalContractVersion: z.literal(1),
}).strict();

const evidenceSchema = z.object({
  evidenceId: z.string().min(1),
  digest,
  reasons: z.array(z.string()),
  inputWindow: z.object({
    firstBarOpenUtc: utcInstant,
    lastBarOpenUtc: utcInstant,
    bars: z.number().int().positive(),
  }).strict(),
  regime: z.unknown(),
  metrics: z.record(z.string(), z.number().nullable()),
}).strict();

const candidateSchema = z.object({
  signal: signalSchema,
  lifecycleState: z.enum(["identified", "expired"]),
  lifecycle: z.array(z.object({
    state: z.enum(["identified", "expired"]),
    effectiveAtUtc: utcInstant,
    reason: z.string().min(1),
    createdAtUtc: utcInstant,
  }).strict()),
  createdAtUtc: utcInstant,
}).strict();

export const signalWorkbenchRunSchema = z.object({
  runId,
  status: z.enum(["pending", "running", "succeeded", "blocked", "failed"]),
  outcome: z.enum(["pending", "running", "candidate", "wait", "blocked", "failed"]),
  attempts: z.number().int().nonnegative(),
  assessedAtUtc: utcInstant,
  createdAtUtc: utcInstant,
  updatedAtUtc: utcInstant,
  failureReason: z.string().nullable(),
  dataset: datasetLineageSchema,
  rule: ruleLineageSchema,
  evidence: evidenceSchema.nullable(),
  candidate: candidateSchema.nullable(),
}).strict();

const safetySchema = z.object({
  uiAuthority: z.literal(false),
  legacyScannerAuthoritative: z.literal(false),
  researchAuthorityInvoked: z.literal(false),
  riskPaperAuthorityInvoked: z.literal(false),
  liveExecutionEnabled: z.literal(false),
  providerOrderTransportEnabled: z.literal(false),
}).strict();

export const signalWorkbenchListSchema = z.object({
  schemaVersion: z.literal(1),
  authority: z.literal("sqlite"),
  datasets: z.array(workbenchDatasetSchema),
  evaluations: z.object({
    total: z.number().int().nonnegative(),
    limit: z.literal(100),
    runs: z.array(signalWorkbenchRunSchema),
  }).strict(),
  ordering: z.literal("assessedAtUtc desc, createdAtUtc desc, runId desc"),
  safety: safetySchema,
}).strict();

export const signalWorkbenchDetailSchema = z.object({
  schemaVersion: z.literal(1),
  authority: z.literal("sqlite"),
  run: signalWorkbenchRunSchema,
  safety: safetySchema,
}).strict();

export type WorkbenchDataset = z.infer<typeof workbenchDatasetSchema>;
export type SignalWorkbenchRun = z.infer<typeof signalWorkbenchRunSchema>;
export type SignalWorkbenchList = z.infer<typeof signalWorkbenchListSchema>;

export type WorkbenchResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

async function readEnvelope<T>(response: Response, schema: z.ZodType<T>): Promise<WorkbenchResult<T>> {
  const body = (await response.json()) as {
    ok?: boolean;
    data?: unknown;
    error?: { message?: unknown };
  };
  if (response.status !== 200 || body.ok !== true) {
    return {
      ok: false,
      error: typeof body.error?.message === "string"
        ? body.error.message
        : `Backend returned HTTP ${response.status}.`,
    };
  }
  const parsed = schema.safeParse(body.data);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, error: "Signal workbench response failed schema validation." };
}

export async function fetchSignalWorkbench(
  cookie?: string,
): Promise<WorkbenchResult<SignalWorkbenchList>> {
  try {
    const response = await fetch(`${BFF_API_URL}/api/signals/evaluations`, {
      headers: cookie ? { cookie } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    return await readEnvelope(response, signalWorkbenchListSchema);
  } catch {
    return { ok: false, error: "Signal workbench service unreachable." };
  }
}

export async function fetchSignalEvaluation(
  evaluationRunId: string,
  cookie?: string,
): Promise<WorkbenchResult<SignalWorkbenchRun>> {
  if (!runId.safeParse(evaluationRunId).success) {
    return { ok: false, error: "Signal evaluation id is invalid." };
  }
  try {
    const response = await fetch(
      `${BFF_API_URL}/api/signals/evaluations/${encodeURIComponent(evaluationRunId)}`,
      {
        headers: cookie ? { cookie } : {},
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      },
    );
    const parsed = await readEnvelope(response, signalWorkbenchDetailSchema);
    return parsed.ok ? { ok: true, data: parsed.data.run } : parsed;
  } catch {
    return { ok: false, error: "Signal evaluation detail is unreachable." };
  }
}

const submissionResultSchema = z.object({
  result: z.object({
    runId,
    status: z.enum(["succeeded", "blocked", "failed"]),
    executed: z.boolean(),
    outcome: z.enum(["candidate", "wait", "blocked"]).nullable(),
  }),
});

export async function submitSignalEvaluation(payload: {
  datasetId: string;
  assessedAtUtc: string;
}): Promise<WorkbenchResult<z.infer<typeof submissionResultSchema>["result"]>> {
  try {
    const response = await fetch("/api/signals/evaluations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    const parsed = await readEnvelope(response, submissionResultSchema);
    return parsed.ok ? { ok: true, data: parsed.data.result } : parsed;
  } catch {
    return { ok: false, error: "Signal evaluation submission failed." };
  }
}
