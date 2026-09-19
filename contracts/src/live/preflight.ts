/**
 * Live preflight checklist (P17-01, ADR-0031).
 *
 * Machine-checkable gate between demo execution (P16) and any live pilot:
 * before live trading may be enabled, EVERY gate below must pass on
 * verifiable evidence. Live execution remains OFF by default; a preflight
 * result with `enabled: true` is the ONLY output that can ever authorize a
 * live session (P17-02 then requires a human approval on top).
 *
 * Gates (frozen vocabulary; changes need an ADR):
 * 1. strategy_champion  — champion state in the P09 promotion registry.
 * 2. paper_period       — minimum completed paper trading days.
 * 3. demo_stability     — completed demo period, no monitor breaches,
 *    drawdown and reject rate within thresholds.
 * 4. risk_tests         — risk suite passed with a report hash link.
 * 5. reconciliation     — paper/demo ledgers clean, drift in threshold,
 *    last reconciliation fresh (not stale).
 * 6. outage_tests       — data and broker outage fail-closed paths verified.
 * 7. operator_readiness — trained operator with a current runbook ack.
 * 8. explicit_approval  — human approval reference (P17-02 record).
 *
 * All timestamps UTC (ADR-0004); deterministic for deterministic inputs
 * (`nowUtc` is an input, never a wall clock); no broker access; no secrets
 * in any field (schema rejects secret-shaped keys in the context bag).
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";
import { obsAttributeRecordSchema } from "../obs/logging";

export const LIVE_GATE_ID = "live-gate";
export const LIVE_GATE_VERSION = "1.0.0";

export class LiveGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveGateError";
  }
}

/** Frozen gate vocabulary (order is the checklist order). */
export const LIVE_PREFLIGHT_GATES = [
  "strategy_champion",
  "paper_period",
  "demo_stability",
  "risk_tests",
  "reconciliation",
  "outage_tests",
  "operator_readiness",
  "explicit_approval",
] as const;
export type LivePreflightGate = (typeof LIVE_PREFLIGHT_GATES)[number];
export const livePreflightGateSchema = z.enum(LIVE_PREFLIGHT_GATES);

// ---------------------------------------------------------------------------
// Gate evidence schemas (fail-closed zod validation at the boundary)
// ---------------------------------------------------------------------------

/** P09 promotion registry evidence for the champion gate. */
export const championEvidenceSchema = z
  .object({
    strategyId: z.string().min(1),
    strategyVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    /** Must be `champion` for the gate to pass; other states fail closed. */
    promotionState: z.enum(["candidate", "challenger", "champion", "retired", "rejected"]),
    /** P09 evidence bundle hash (64 lowercase hex) — must be attached. */
    evidenceHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  })
  .strict();
export type ChampionEvidence = z.infer<typeof championEvidenceSchema>;

/** Completed paper period evidence. */
export const paperPeriodEvidenceSchema = z
  .object({
    startedAtUtc: utcInstantSchema,
    endedAtUtc: utcInstantSchema,
    /** Whole trading days completed inside the window (caller-computed). */
    tradingDaysCompleted: z.number().int().min(0),
  })
  .strict()
  .refine((p) => p.endedAtUtc >= p.startedAtUtc, {
    message: "paper period endedAtUtc must not precede startedAtUtc",
    path: ["endedAtUtc"],
  });
export type PaperPeriodEvidence = z.infer<typeof paperPeriodEvidenceSchema>;

/** Completed demo period stability evidence. */
export const demoStabilityEvidenceSchema = z
  .object({
    startedAtUtc: utcInstantSchema,
    endedAtUtc: utcInstantSchema,
    tradingDaysCompleted: z.number().int().min(0),
    /** P16-04 monitor breaches during the period (0 required to pass). */
    monitorBreaches: z.number().int().min(0),
    /** Max drawdown observed, percent of equity. */
    maxDrawdownPct: z.number().min(0),
    /** Reject rate observed, percent (0-100). */
    rejectRatePct: z.number().min(0).max(100),
  })
  .strict()
  .refine((p) => p.endedAtUtc >= p.startedAtUtc, {
    message: "demo period endedAtUtc must not precede startedAtUtc",
    path: ["endedAtUtc"],
  });
export type DemoStabilityEvidence = z.infer<typeof demoStabilityEvidenceSchema>;

/** Risk test suite evidence. */
export const riskTestsEvidenceSchema = z
  .object({
    suiteName: z.string().min(1),
    passed: z.boolean(),
    /** Hash linking the test report artifact. */
    reportHash: z.string().regex(/^[0-9a-f]{64}$/),
    executedAtUtc: utcInstantSchema,
  })
  .strict();
export type RiskTestsEvidence = z.infer<typeof riskTestsEvidenceSchema>;

/** Reconciliation evidence for paper and demo ledgers. */
export const reconciliationEvidenceSchema = z
  .object({
    paperClean: z.boolean(),
    demoClean: z.boolean(),
    /** Ledger drift observed, percent (0-100). */
    driftPct: z.number().min(0).max(100),
    lastReconciledAtUtc: utcInstantSchema,
  })
  .strict();
export type ReconciliationEvidence = z.infer<typeof reconciliationEvidenceSchema>;

/** Outage fail-closed test evidence. */
export const outageTestsEvidenceSchema = z
  .object({
    dataOutageFailedClosed: z.boolean(),
    brokerOutageFailedClosed: z.boolean(),
    testedAtUtc: utcInstantSchema,
  })
  .strict();
export type OutageTestsEvidence = z.infer<typeof outageTestsEvidenceSchema>;

/** Operator readiness evidence. */
export const operatorReadinessEvidenceSchema = z
  .object({
    operatorId: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
    runbookVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    trained: z.boolean(),
    acknowledgedAtUtc: utcInstantSchema,
  })
  .strict();
export type OperatorReadinessEvidence = z.infer<typeof operatorReadinessEvidenceSchema>;

/**
 * Explicit human approval reference (P17-02 owns the immutable record; the
 * preflight only links to an approval id and verifies presence + shape).
 */
export const approvalEvidenceSchema = z
  .object({
    /** P17-02 approval record id (`lapp_` + 16 hex) — must exist. */
    approvalId: z.string().regex(/^lapp_[0-9a-f]{16}$/),
    approvedBy: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
    approvedAtUtc: utcInstantSchema,
  })
  .strict();
export type ApprovalEvidence = z.infer<typeof approvalEvidenceSchema>;


// ---------------------------------------------------------------------------
// Checklist input + thresholds
// ---------------------------------------------------------------------------

/** Thresholds the checklist enforces (frozen defaults; changes need an ADR). */
export const livePreflightThresholdsSchema = z
  .object({
    /** Minimum completed paper trading days. */
    minPaperTradingDays: z.number().int().min(1),
    /** Minimum completed demo trading days. */
    minDemoTradingDays: z.number().int().min(1),
    /** Maximum demo max drawdown, percent of equity. */
    maxDemoDrawdownPct: z.number().min(0),
    /** Maximum demo reject rate, percent. */
    maxDemoRejectRatePct: z.number().min(0).max(100),
    /** Maximum ledger drift, percent. */
    maxDriftPct: z.number().min(0).max(100),
    /** Maximum age of the last reconciliation, in ms, before stale. */
    maxReconciliationAgeMs: z.number().int().min(1),
    /** Maximum age of the outage test run, in ms, before stale. */
    maxOutageTestAgeMs: z.number().int().min(1),
    /** Maximum age of the operator acknowledgement, in ms, before stale. */
    maxOperatorAckAgeMs: z.number().int().min(1),
  })
  .strict();
export type LivePreflightThresholds = z.infer<typeof livePreflightThresholdsSchema>;

export const DEFAULT_LIVE_PREFLIGHT_THRESHOLDS: LivePreflightThresholds = Object.freeze({
  minPaperTradingDays: 30,
  minDemoTradingDays: 20,
  maxDemoDrawdownPct: 5,
  maxDemoRejectRatePct: 5,
  maxDriftPct: 1,
  maxReconciliationAgeMs: 24 * 60 * 60 * 1000, // 24h
  maxOutageTestAgeMs: 7 * 24 * 60 * 60 * 1000, // 7d
  maxOperatorAckAgeMs: 30 * 24 * 60 * 60 * 1000, // 30d
});

/** The full preflight input: one evidence bundle per gate. */
export const livePreflightInputSchema = z
  .object({
    strategyChampion: championEvidenceSchema,
    paperPeriod: paperPeriodEvidenceSchema,
    demoStability: demoStabilityEvidenceSchema,
    riskTests: riskTestsEvidenceSchema,
    reconciliation: reconciliationEvidenceSchema,
    outageTests: outageTestsEvidenceSchema,
    operatorReadiness: operatorReadinessEvidenceSchema,
    explicitApproval: approvalEvidenceSchema,
    thresholds: livePreflightThresholdsSchema.default({ ...DEFAULT_LIVE_PREFLIGHT_THRESHOLDS }),
    /** Evaluation instant (UTC, caller-supplied — never a wall clock). */
    nowUtc: utcInstantSchema,
    /** Redacted context bag (no secret-shaped keys; fail closed). */
    context: obsAttributeRecordSchema.default({}),
  })
  .strict();
export type LivePreflightInput = z.infer<typeof livePreflightInputSchema>;


// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** One gate outcome. */
export const liveGateOutcomeSchema = z
  .object({
    gate: livePreflightGateSchema,
    passed: z.boolean(),
    reason: z.string().min(1),
  })
  .strict();
export type LiveGateOutcome = z.infer<typeof liveGateOutcomeSchema>;

export const livePreflightResultSchema = z
  .object({
    checklistId: z.string().regex(/^lpf_[0-9a-f]{16}$/),
    evaluatedAtUtc: utcInstantSchema,
    /** True ONLY when every gate passed (live may be enabled). */
    enabled: z.boolean(),
    outcomes: z.array(liveGateOutcomeSchema),
  })
  .strict()
  .refine((r) => r.outcomes.length === LIVE_PREFLIGHT_GATES.length, {
    message: "result must carry one outcome per gate",
    path: ["outcomes"],
  })
  .refine(
    (r) => r.enabled === r.outcomes.every((o) => o.passed),
    {
      message: "enabled is true only when all gates pass",
      path: ["enabled"],
    },
  );
export type LivePreflightResult = z.infer<typeof livePreflightResultSchema>;

// ---------------------------------------------------------------------------
// Deterministic checklist id (content-addressed)
// ---------------------------------------------------------------------------

function outcomeToken(o: LiveGateOutcome): string {
  return `${o.gate}:${o.passed ? 1 : 0}:${o.reason}`;
}

export function serializePreflightContentCanonical(
  result: Omit<LivePreflightResult, "checklistId">,
): string {
  return [
    "lpf",
    result.evaluatedAtUtc,
    result.enabled ? 1 : 0,
    result.outcomes.map(outcomeToken).join("|"),
  ].join("|");
}

/** FNV-1a64 hex (same primitive as obs/logging.ts). */
function fnv1a64(text: string): string {
  const mask = (1n << 64n) - 1n;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Deterministic checklist id from result content. */
export function livePreflightIdFor(result: Omit<LivePreflightResult, "checklistId">): string {
  return `lpf_${fnv1a64(serializePreflightContentCanonical(result))}`;
}

/** Age in ms between two UTC instants (both caller inputs — deterministic). */
function ageMs(atUtc: string, nowUtc: string): number {
  return Date.parse(nowUtc) - Date.parse(atUtc);
}


// ---------------------------------------------------------------------------
// Checklist evaluation
// ---------------------------------------------------------------------------

/**
 * Run the machine-checkable preflight checklist. Deterministic: the same
 * input always yields the same result (including the same checklistId).
 * Every gate is REQUIRED; one failed gate means `enabled: false`.
 */
export function runLivePreflight(rawInput: LivePreflightInput): LivePreflightResult {
  const input = livePreflightInputSchema.parse(rawInput);
  const t = input.thresholds;

  const outcomes: LiveGateOutcome[] = [
    {
      gate: "strategy_champion",
      passed:
        input.strategyChampion.promotionState === "champion" &&
        input.strategyChampion.evidenceHash !== null,
      reason:
        input.strategyChampion.promotionState !== "champion"
          ? `promotion state is '${input.strategyChampion.promotionState}', champion required`
          : input.strategyChampion.evidenceHash === null
            ? "champion has no attached evidence bundle"
            : `champion ${input.strategyChampion.strategyId}@${input.strategyChampion.strategyVersion} with evidence`,
    },
    {
      gate: "paper_period",
      passed: input.paperPeriod.tradingDaysCompleted >= t.minPaperTradingDays,
      reason: `paper trading days ${input.paperPeriod.tradingDaysCompleted} (min ${t.minPaperTradingDays})`,
    },
    {
      gate: "demo_stability",
      passed:
        input.demoStability.tradingDaysCompleted >= t.minDemoTradingDays &&
        input.demoStability.monitorBreaches === 0 &&
        input.demoStability.maxDrawdownPct <= t.maxDemoDrawdownPct &&
        input.demoStability.rejectRatePct <= t.maxDemoRejectRatePct,
      reason:
        input.demoStability.tradingDaysCompleted < t.minDemoTradingDays
          ? `demo trading days ${input.demoStability.tradingDaysCompleted} (min ${t.minDemoTradingDays})`
          : input.demoStability.monitorBreaches > 0
            ? `demo monitor breaches ${input.demoStability.monitorBreaches} (0 required)`
            : input.demoStability.maxDrawdownPct > t.maxDemoDrawdownPct
              ? `demo drawdown ${input.demoStability.maxDrawdownPct}% exceeds ${t.maxDemoDrawdownPct}%`
              : input.demoStability.rejectRatePct > t.maxDemoRejectRatePct
                ? `demo reject rate ${input.demoStability.rejectRatePct}% exceeds ${t.maxDemoRejectRatePct}%`
                : `demo stable: ${input.demoStability.tradingDaysCompleted} days, drawdown ${input.demoStability.maxDrawdownPct}%, rejects ${input.demoStability.rejectRatePct}%`,
    },
    {
      gate: "risk_tests",
      passed: input.riskTests.passed,
      reason: input.riskTests.passed
        ? `risk suite '${input.riskTests.suiteName}' passed at ${input.riskTests.executedAtUtc}`
        : `risk suite '${input.riskTests.suiteName}' did not pass`,
    },

    (() => {
      const stale =
        ageMs(input.reconciliation.lastReconciledAtUtc, input.nowUtc) > t.maxReconciliationAgeMs;
      const clean = input.reconciliation.paperClean && input.reconciliation.demoClean;
      const driftOk = input.reconciliation.driftPct <= t.maxDriftPct;
      const passed = clean && driftOk && !stale;
      const reason = !clean
        ? `ledgers not clean (paper=${input.reconciliation.paperClean}, demo=${input.reconciliation.demoClean})`
        : !driftOk
          ? `drift ${input.reconciliation.driftPct}% exceeds ${t.maxDriftPct}%`
          : stale
            ? `last reconciliation ${input.reconciliation.lastReconciledAtUtc} is stale (older than ${t.maxReconciliationAgeMs}ms at ${input.nowUtc})`
            : `reconciled clean, drift ${input.reconciliation.driftPct}%`;
      return { gate: "reconciliation" as const, passed, reason };
    })(),
    (() => {
      const stale = ageMs(input.outageTests.testedAtUtc, input.nowUtc) > t.maxOutageTestAgeMs;
      const passed =
        input.outageTests.dataOutageFailedClosed &&
        input.outageTests.brokerOutageFailedClosed &&
        !stale;
      const reason = stale
        ? `outage test at ${input.outageTests.testedAtUtc} is stale (older than ${t.maxOutageTestAgeMs}ms at ${input.nowUtc})`
        : !input.outageTests.dataOutageFailedClosed || !input.outageTests.brokerOutageFailedClosed
          ? `outage fail-closed paths not verified (data=${input.outageTests.dataOutageFailedClosed}, broker=${input.outageTests.brokerOutageFailedClosed})`
          : `outage fail-closed verified at ${input.outageTests.testedAtUtc}`;
      return { gate: "outage_tests" as const, passed, reason };
    })(),
    (() => {
      const stale =
        ageMs(input.operatorReadiness.acknowledgedAtUtc, input.nowUtc) > t.maxOperatorAckAgeMs;
      const passed = input.operatorReadiness.trained && !stale;
      const reason = stale
        ? `operator ack at ${input.operatorReadiness.acknowledgedAtUtc} is stale (older than ${t.maxOperatorAckAgeMs}ms at ${input.nowUtc})`
        : !input.operatorReadiness.trained
          ? `operator '${input.operatorReadiness.operatorId}' not trained`
          : `operator '${input.operatorReadiness.operatorId}' trained on runbook ${input.operatorReadiness.runbookVersion}`;
      return { gate: "operator_readiness" as const, passed, reason };
    })(),
    {
      gate: "explicit_approval",
      passed: true,
      reason: `approval ${input.explicitApproval.approvalId} by ${input.explicitApproval.approvedBy} at ${input.explicitApproval.approvedAtUtc}`,
    },
  ];

  const enabled = outcomes.every((o) => o.passed);
  const core = { evaluatedAtUtc: input.nowUtc, enabled, outcomes };
  const checklistId = livePreflightIdFor(core);
  return livePreflightResultSchema.parse({ ...core, checklistId });
}

/**
 * Fail-closed assertion helper: throws `LiveGateError` unless the result
 * authorizes live. Startup / session-open code calls this instead of
 * trusting the boolean directly.
 */
export function assertLivePreflightPassed(result: LivePreflightResult): void {
  const parsed = livePreflightResultSchema.parse(result);
  if (!parsed.enabled) {
    const failed = parsed.outcomes.filter((o) => !o.passed).map((o) => o.gate);
    throw new LiveGateError(`live preflight failed; blocking gates: ${failed.join(", ")}`);
  }
}


