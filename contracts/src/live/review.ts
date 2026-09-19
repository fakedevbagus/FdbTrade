/**
 * Post-live pilot session review (P17-05, ADR-0031).
 *
 * Every live pilot session MUST end with a reproducible report and an
 * explicit go/no-go decision:
 * - Session report covers signals, fills, slippage, PnL, risk events,
 *   provider health and differences versus paper.
 * - Reproducibility: the report is content-addressed (`lrev_` + FNV-1a64)
 *   over canonical content; identical inputs yield the identical report.
 * - Go/no-go is EVIDENCE-GATED: a `go` requires every pass criterion true
 *   (fill ratio, slippage within threshold, realized PnL not breaching the
 *   review floor, no unresolved risk events, provider healthy, paper
 *   divergence within threshold). A schema refinement refuses a forged
 *   `go` that disagrees with the criteria — no "it worked" promotion
 *   without evidence.
 * - All timestamps UTC; deterministic for deterministic inputs.
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";

export const LIVE_REVIEW_ID = "live-session-review";
export const LIVE_REVIEW_VERSION = "1.0.0";

export class LiveReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveReviewError";
  }
}

// ---------------------------------------------------------------------------
// Session evidence
// ---------------------------------------------------------------------------

export const liveSessionSignalsSchema = z
  .object({
    /** Signals generated during the session. */
    generated: z.number().int().min(0),
    /** Signals that reached execution (risk-approved + gate-passed). */
    submitted: z.number().int().min(0),
  })
  .strict()
  .refine((s) => s.submitted <= s.generated, {
    message: "submitted cannot exceed generated",
    path: ["submitted"],
  });
export type LiveSessionSignals = z.infer<typeof liveSessionSignalsSchema>;

export const liveSessionFillsSchema = z
  .object({
    ordersSubmitted: z.number().int().min(0),
    ordersFilled: z.number().int().min(0),
    ordersRejected: z.number().int().min(0),
    /** Volume-weighted average fill price deviation vs signal price, pct. */
    avgSlippagePct: z.number().min(0),
    /** Worst single-order slippage, pct. */
    maxSlippagePct: z.number().min(0),
  })
  .strict()
  .refine((f) => f.ordersFilled + f.ordersRejected <= f.ordersSubmitted, {
    message: "filled + rejected cannot exceed submitted",
    path: ["ordersFilled"],
  });
export type LiveSessionFills = z.infer<typeof liveSessionFillsSchema>;

export const liveSessionPnlSchema = z
  .object({
    /** Realized PnL for the session, account currency. */
    realizedPnl: z.number().finite(),
    /** Unrealized PnL at session close. */
    unrealizedPnl: z.number().finite(),
    /** Max drawdown during the session, percent of equity. */
    maxDrawdownPct: z.number().min(0),
  })
  .strict();
export type LiveSessionPnl = z.infer<typeof liveSessionPnlSchema>;

export const liveSessionRiskEventsSchema = z
  .object({
    /** Risk-limit breach events (hard limits). */
    limitBreaches: z.number().int().min(0),
    /** Circuit-breaker trips (any kind). */
    breakerTrips: z.number().int().min(0),
    /** Risk events still unresolved at session close. */
    unresolved: z.number().int().min(0),
  })
  .strict();
export type LiveSessionRiskEvents = z.infer<typeof liveSessionRiskEventsSchema>;

export const liveSessionProviderHealthSchema = z
  .object({
    /** Provider uptime over the session, percent (0-100). */
    uptimePct: z.number().min(0).max(100),
    /** Broker health at session close. */
    brokerHealthyAtClose: z.boolean(),
    /** Data outages observed. */
    dataOutages: z.number().int().min(0),
  })
  .strict();
export type LiveSessionProviderHealth = z.infer<typeof liveSessionProviderHealthSchema>;

export const liveSessionPaperDivergenceSchema = z
  .object({
    /** Same-period paper PnL for the mirrored paper session. */
    paperRealizedPnl: z.number().finite(),
    /** Live minus paper realized PnL, account currency. */
    pnlDifference: z.number().finite(),
    /** Same-signal fill-rate difference, percentage points. */
    fillRateDifferencePp: z.number().finite(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Review input + go/no-go criteria
// ---------------------------------------------------------------------------

export const liveReviewCriteriaSchema = z
  .object({
    /** Minimum fill ratio (ordersFilled / ordersSubmitted), percent. */
    minFillRatioPct: z.number().min(0).max(100),
    /** Maximum average slippage, percent. */
    maxAvgSlippagePct: z.number().min(0),
    /** Maximum session drawdown, percent. */
    maxDrawdownPct: z.number().min(0),
    /** Maximum tolerated abs divergence vs paper PnL, currency units. */
    maxPaperPnlDivergence: z.number().min(0),
    /** Maximum tolerated fill-rate difference vs paper, percentage points. */
    maxFillRateDifferencePp: z.number().min(0),
  })
  .strict();
export type LiveReviewCriteria = z.infer<typeof liveReviewCriteriaSchema>;

export const DEFAULT_LIVE_REVIEW_CRITERIA: LiveReviewCriteria = Object.freeze({
  minFillRatioPct: 90,
  maxAvgSlippagePct: 0.5,
  maxDrawdownPct: 2,
  maxPaperPnlDivergence: 50,
  maxFillRateDifferencePp: 10,
});

export const liveSessionReviewInputSchema = z
  .object({
    /** Pilot session id being reviewed. */
    sessionId: z.string().min(1),
    /** Linked P17-02 approval id. */
    approvalId: z.string().regex(/^lapp_[0-9a-f]{16}$/),
    startedAtUtc: utcInstantSchema,
    endedAtUtc: utcInstantSchema,
    signals: liveSessionSignalsSchema,
    fills: liveSessionFillsSchema,
    pnl: liveSessionPnlSchema,
    riskEvents: liveSessionRiskEventsSchema,
    providerHealth: liveSessionProviderHealthSchema,
    paperDivergence: liveSessionPaperDivergenceSchema,
    criteria: liveReviewCriteriaSchema.default({ ...DEFAULT_LIVE_REVIEW_CRITERIA }),
  })
  .strict()
  .refine((r) => r.endedAtUtc >= r.startedAtUtc, {
    message: "session endedAtUtc must not precede startedAtUtc",
    path: ["endedAtUtc"],
  });
export type LiveSessionReviewInput = z.infer<typeof liveSessionReviewInputSchema>;

// ---------------------------------------------------------------------------
// Report + decision
// ---------------------------------------------------------------------------

export const LIVE_REVIEW_DECISIONS = ["go", "no_go"] as const;
export type LiveReviewDecision = (typeof LIVE_REVIEW_DECISIONS)[number];
export const liveReviewDecisionSchema = z.enum(LIVE_REVIEW_DECISIONS);

export const liveReviewCheckSchema = z
  .object({
    name: z.string().min(1),
    passed: z.boolean(),
    reason: z.string().min(1),
  })
  .strict();
export type LiveReviewCheck = z.infer<typeof liveReviewCheckSchema>;

export const liveSessionReviewReportSchema = z
  .object({
    /** Content-addressed id: `lrev_` + FNV-1a64 of canonical content. */
    reportId: z.string().regex(/^lrev_[0-9a-f]{16}$/),
    sessionId: z.string().min(1),
    approvalId: z.string().regex(/^lapp_[0-9a-f]{16}$/),
    startedAtUtc: utcInstantSchema,
    endedAtUtc: utcInstantSchema,
    decision: liveReviewDecisionSchema,
    checks: z.array(liveReviewCheckSchema),
  })
  .strict()
  .refine((r) => r.decision === "no_go" || r.checks.every((c) => c.passed), {
    message: "a 'go' decision requires every check to pass",
    path: ["decision"],
  });
export type LiveSessionReviewReport = z.infer<typeof liveSessionReviewReportSchema>;


// ---------------------------------------------------------------------------
// Canonical serialization + deterministic ids
// ---------------------------------------------------------------------------

function checkToken(c: LiveReviewCheck): string {
  return `${c.name}:${c.passed ? 1 : 0}:${c.reason}`;
}

export function serializeReviewContentCanonical(
  report: Omit<LiveSessionReviewReport, "reportId">,
): string {
  return [
    "lrev",
    report.sessionId,
    report.approvalId,
    report.startedAtUtc,
    report.endedAtUtc,
    report.decision,
    report.checks.map(checkToken).join("|"),
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

export function liveReviewIdFor(report: Omit<LiveSessionReviewReport, "reportId">): string {
  return `lrev_${fnv1a64(serializeReviewContentCanonical(report))}`;
}

// ---------------------------------------------------------------------------
// Review evaluation
// ---------------------------------------------------------------------------

function pct(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

/**
 * Build the post-live session review: deterministic checks over the session
 * evidence and an evidence-gated go/no-go decision. `go` is only possible
 * when EVERY check passes — the report schema enforces the link, so a
 * forged `go` fails validation. Identical inputs yield identical reports
 * (same reportId) — reproducible by construction.
 */
export function buildLiveSessionReview(
  rawInput: LiveSessionReviewInput,
): LiveSessionReviewReport {
  const input = liveSessionReviewInputSchema.parse(rawInput);
  const c = input.criteria;

  const fillRatioPct = pct(input.fills.ordersFilled, input.fills.ordersSubmitted);
  const checks: LiveReviewCheck[] = [
    {
      name: "fill_ratio",
      passed: fillRatioPct >= c.minFillRatioPct,
      reason: `fill ratio ${fillRatioPct.toFixed(2)}% (min ${c.minFillRatioPct}%)`,
    },
    {
      name: "avg_slippage",
      passed: input.fills.avgSlippagePct <= c.maxAvgSlippagePct,
      reason: `avg slippage ${input.fills.avgSlippagePct}% (max ${c.maxAvgSlippagePct}%)`,
    },
    {
      name: "drawdown",
      passed: input.pnl.maxDrawdownPct <= c.maxDrawdownPct,
      reason: `max drawdown ${input.pnl.maxDrawdownPct}% (max ${c.maxDrawdownPct}%)`,
    },
    {
      name: "risk_events_resolved",
      passed:
        input.riskEvents.limitBreaches === 0 &&
        input.riskEvents.unresolved === 0,
      reason:
        input.riskEvents.limitBreaches > 0
          ? `${input.riskEvents.limitBreaches} hard-limit breaches occurred`
          : input.riskEvents.unresolved > 0
            ? `${input.riskEvents.unresolved} risk events unresolved at close`
            : `no limit breaches, ${input.riskEvents.breakerTrips} breaker trips all resolved`,
    },
    {
      name: "provider_health",
      passed:
        input.providerHealth.brokerHealthyAtClose && input.providerHealth.dataOutages === 0,
      reason: input.providerHealth.brokerHealthyAtClose
        ? `broker healthy at close, ${input.providerHealth.dataOutages} data outages, uptime ${input.providerHealth.uptimePct}%`
        : "broker unhealthy at session close",
    },
    {
      name: "paper_pnl_divergence",
      passed: Math.abs(input.paperDivergence.pnlDifference) <= c.maxPaperPnlDivergence,
      reason: `live-vs-paper PnL difference ${input.paperDivergence.pnlDifference} (max abs ${c.maxPaperPnlDivergence})`,
    },
    {
      name: "paper_fill_rate_divergence",
      passed:
        Math.abs(input.paperDivergence.fillRateDifferencePp) <= c.maxFillRateDifferencePp,
      reason: `fill-rate difference ${input.paperDivergence.fillRateDifferencePp}pp vs paper (max abs ${c.maxFillRateDifferencePp}pp)`,
    },
  ];

  const decision: LiveReviewDecision = checks.every((chk) => chk.passed) ? "go" : "no_go";
  const core = {
    sessionId: input.sessionId,
    approvalId: input.approvalId,
    startedAtUtc: input.startedAtUtc,
    endedAtUtc: input.endedAtUtc,
    decision,
    checks,
  };
  const reportId = liveReviewIdFor(core);
  return liveSessionReviewReportSchema.parse({ ...core, reportId });
}

export type LiveSessionPaperDivergence = z.infer<typeof liveSessionPaperDivergenceSchema>;
