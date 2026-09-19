/**
 * Independent risk service boundary (P11-01, ADR-0022).
 *
 * The risk engine is INDEPENDENT of strategy logic (blueprint locked
 * decision): strategy -> signal -> risk -> execution is a hard boundary.
 * Strategy/feature/UI/LLM code may CALL this contract, may never bypass it,
 * and never reaches a broker. Every paper/demo/live order intent must carry
 * an APPROVED `RiskDecision` before it may leave the `intent` state (see
 * `assertRiskGateCleared` and the P10 `intent -> risk_checked` transition).
 *
 * Semantics frozen here:
 * - The check is a PURE function of a fully typed, zod-validated request
 *   (lineage + account snapshot + open-position snapshot + market freshness
 *   snapshot + latched risk state) and a versioned limits config. No wall
 *   clock, no randomness, no network, no broker access (ADR-0003/0005).
 * - All internal timestamps are UTC (ADR-0004).
 * - Rejections carry machine-readable reason codes (`RISK_REJECT_REASONS`).
 * - `decisionId` is content-addressed (`riskdec_` + FNV-1a64): the same
 *   request/config/state always produces the same decision id (idempotent).
 * - Uncertainty (stale data, provider outage/unknown health) FAILS CLOSED.
 * - No secret-bearing fields exist in the request or decision schemas.
 */
import { z } from "zod";

import { featureVersionSchema } from "../feature/definition";
import { instrumentIdSchema } from "../marketdata/instrument";
import { TIMEFRAME_MS, timeframeSchema, utcInstantSchema } from "../marketdata/time";
import { signalDirectionSchema, signalEntryTypeSchema } from "../strategy/contract";

import { riskStateSchema, RISK_STATES_ALLOWING_NEW_ENTRIES, type RiskState } from "./states";
import { riskHash16 } from "./util";

export const RISK_ENGINE_ID = "risk-engine";
export const RISK_ENGINE_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Rejection reason codes (frozen vocabulary; adding a code needs an ADR)
// ---------------------------------------------------------------------------

export const RISK_REJECT_REASONS = [
  "risk_kill_engaged",
  "risk_state_orange",
  "risk_state_red",
  "risk_data_stale",
  "risk_provider_unhealthy",
  "risk_daily_loss_stop",
  "risk_weekly_drawdown_stop",
  "risk_max_open_positions",
  "risk_spread_cap",
  "risk_slippage_cap",
  "risk_sizing_unfeasible",
  "risk_portfolio_heat_cap",
  "risk_currency_exposure_cap",
  "risk_correlation_cap",
  "risk_redundant_position",
  "risk_redundant_strategy",
] as const;
export type RiskRejectReason = (typeof RISK_REJECT_REASONS)[number];
export const riskRejectReasonSchema = z.enum(RISK_REJECT_REASONS);

/** Market-data provider health (fail closed on anything but `healthy`). */
export const RISK_PROVIDER_HEALTH_STATES = ["healthy", "degraded", "outage", "unknown"] as const;
export type RiskProviderHealth = (typeof RISK_PROVIDER_HEALTH_STATES)[number];
export const riskProviderHealthSchema = z.enum(RISK_PROVIDER_HEALTH_STATES);

// ---------------------------------------------------------------------------
// Request snapshots (typed inputs the risk gate evaluates)
// ---------------------------------------------------------------------------

/** Quote -> account currency conversion metadata (data with provenance). */
export const riskConversionMetadataSchema = z
  .object({
    /** Instrument quote currency (e.g. USD for EURUSD). */
    quoteCurrency: z.string().length(3).regex(/^[A-Z]+$/),
    /** Account/ledger currency (e.g. USD). */
    accountCurrency: z.string().length(3).regex(/^[A-Z]+$/),
    /** quote -> account units, recorded at `rateAtUtc`. */
    conversionRate: z.number().finite().positive(),
    rateAtUtc: utcInstantSchema,
    /** Provenance of the rate (e.g. "fixture"). Never a hard-coded literal. */
    rateSource: z.string().min(1),
  })
  .strict();

export type RiskConversionMetadata = z.infer<typeof riskConversionMetadataSchema>;

/** One OPEN position as the risk gate sees it (input snapshot, not owned). */
export const riskOpenPositionSchema = z
  .object({
    positionId: z.string().min(4),
    instrument: instrumentIdSchema,
    direction: signalDirectionSchema,
    quantityUnits: z.number().finite().positive(),
    avgPrice: z.number().finite().positive(),
    /** Managed protective stop of the open position (risk attribution). */
    stopLoss: z.number().finite().positive(),
    openedAtUtc: utcInstantSchema,
    strategyId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    /** quote -> account conversion for THIS position's instrument. */
    conversion: riskConversionMetadataSchema,
  })
  .strict()
  .refine((p) => p.stopLoss !== p.avgPrice, {
    message: "open position must carry a protective stop distinct from its entry price",
    path: ["stopLoss"],
  });

export type RiskOpenPosition = z.infer<typeof riskOpenPositionSchema>;

/** Account snapshot (equity marks come from the ledger, never from risk). */
export const riskAccountSnapshotSchema = z
  .object({
    accountCurrency: z.string().length(3).regex(/^[A-Z]+$/),
    /** Current marked equity (cash + open unrealized), account ccy. */
    equity: z.number().finite().positive(),
    /** Start of the current UTC trading day + its opening equity. */
    dayStartUtc: utcInstantSchema,
    equityAtDayStart: z.number().finite().positive(),
    /** Start of the current UTC week + its peak equity so far. */
    weekStartUtc: utcInstantSchema,
    weekPeakEquity: z.number().finite().positive(),
  })
  .strict()
  .refine((a) => a.weekPeakEquity >= a.equity, {
    message: "weekPeakEquity cannot be below current equity",
    path: ["weekPeakEquity"],
  });

export type RiskAccountSnapshot = z.infer<typeof riskAccountSnapshotSchema>;

/** Market freshness snapshot for the ENTRY instrument (stale/outage gate). */
export const riskMarketSnapshotSchema = z
  .object({
    instrument: instrumentIdSchema,
    /** Data provider provenance (id only; no credentials). */
    providerId: z.string().min(1),
    providerHealth: riskProviderHealthSchema,
    /** Timeframe of the market feed bars (may differ from the signal tf). */
    barTimeframe: timeframeSchema,
    /** Bar OPEN time (UTC) of the most recent CLOSED bar. */
    lastClosedBarOpenUtc: utcInstantSchema,
    /** Observed spread at the entry instrument, in pips. */
    observedSpreadPips: z.number().finite().nonnegative(),
    /** Estimated adverse slippage for a new fill, in pips. */
    estimatedSlippagePips: z.number().finite().nonnegative(),
    /** quote -> account conversion for the ENTRY instrument (sizing). */
    conversion: riskConversionMetadataSchema,
  })
  .strict();

export type RiskMarketSnapshot = z.infer<typeof riskMarketSnapshotSchema>;

// ---------------------------------------------------------------------------
// Risk check request (P11-01 boundary contract)
// ---------------------------------------------------------------------------

/**
 * The complete, typed input of one independent risk evaluation: verbatim
 * signal lineage + account/positions/market snapshots + the latched risk
 * state (P11-04, tracked upstream by the operator layer; KILL is sticky
 * there, never here). Deterministic for deterministic inputs.
 */
export const riskCheckRequestSchema = z
  .object({
    /** Instant of the evaluation (input; the engine has no clock). */
    checkedAtUtc: utcInstantSchema,
    // --- verbatim lineage (mirrors BacktestOrderIntent; P08 contract) ---
    intentId: z.string().min(4),
    signalId: z.string().min(4),
    strategyId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    strategyVersion: featureVersionSchema,
    configVersion: featureVersionSchema,
    snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
    instrument: instrumentIdSchema,
    timeframe: timeframeSchema,
    direction: signalDirectionSchema,
    entryType: signalEntryTypeSchema,
    /** Resting level (required for stop/limit; null for market). */
    entryPrice: z.number().finite().positive().nullable(),
    referencePrice: z.number().finite().positive(),
    stopLoss: z.number().finite().positive(),
    takeProfit: z.number().finite().positive().nullable(),
    eventTimeUtc: utcInstantSchema,
    expiresAtUtc: utcInstantSchema,
    // --- strategy-proposed size (the risk engine owns the FINAL size) ---
    requestedQuantityUnits: z.number().finite().positive(),
    // --- environment snapshots ---
    account: riskAccountSnapshotSchema,
    openPositions: z.array(riskOpenPositionSchema),
    market: riskMarketSnapshotSchema,
    // --- latched risk state (P11-04; KILL is sticky upstream) ---
    riskState: riskStateSchema,
    /** Override that produced the current state, when one caused it. */
    activeOverrideId: z.string().regex(/^rsov_[0-9a-f]{16}$/).nullable(),
  })
  .strict()
  .refine((r) => r.market.instrument === r.instrument, {
    message: "market snapshot must be for the entry instrument",
    path: ["market"],
  })
  .refine((r) => r.entryType === "market" || r.entryPrice !== null, {
    message: "stop/limit intents require an entryPrice",
    path: ["entryPrice"],
  })
  .refine((r) => {
    const entry = r.entryPrice ?? r.referencePrice;
    if (r.takeProfit !== null && r.takeProfit === r.stopLoss) return false;
    if (r.direction === "long") {
      return r.stopLoss < entry && (r.takeProfit === null || r.takeProfit > entry);
    }
    return r.stopLoss > entry && (r.takeProfit === null || r.takeProfit < entry);
  }, {
    message: "levels must be direction-consistent",
    path: ["stopLoss"],
  })
  .refine((r) => {
    const ids = r.openPositions.map((p) => p.positionId);
    return new Set(ids).size === ids.length;
  }, {
    message: "openPositions must carry unique positionIds",
    path: ["openPositions"],
  });

export type RiskCheckRequest = z.infer<typeof riskCheckRequestSchema>;

// ---------------------------------------------------------------------------
// Risk decision (the only verdict format downstream may consume)
// ---------------------------------------------------------------------------

/** Content-addressed decision id shape (`riskdec_` + 16 hex). */
export const riskDecisionIdSchema = z.string().regex(/^riskdec_[0-9a-f]{16}$/);

export const riskDecisionSchema = z
  .object({
    decisionId: riskDecisionIdSchema,
    riskEngineId: z.literal(RISK_ENGINE_ID),
    riskEngineVersion: z.literal(RISK_ENGINE_VERSION),
    riskConfigVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    checkedAtUtc: utcInstantSchema,
    // --- lineage echo (auditable end-to-end) ---
    intentId: z.string().min(4),
    signalId: z.string().min(4),
    strategyId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    instrument: instrumentIdSchema,
    direction: signalDirectionSchema,
    outcome: z.enum(["approved", "rejected"]),
    /** FINAL size the risk engine authorizes (0 when rejected). */
    sizedQuantityUnits: z.number().finite().nonnegative(),
    requestedQuantityUnits: z.number().finite().positive(),
    /** True when the engine reduced the requested size to the risk budget. */
    sizeAdjusted: z.boolean(),
    /** Planned risk of the FINAL size, account ccy (planned, not promised). */
    riskAmountAccount: z.number().finite().nonnegative(),
    riskFractionUsed: z.number().finite().nonnegative(),
    /** Machine-readable reasons; empty iff approved. */
    reasons: z.array(riskRejectReasonSchema),
    riskState: riskStateSchema,
    /** Utilization of the OPEN portfolio at check time (observability). */
    utilization: z
      .object({
        portfolioHeatRatio: z.number().finite().nonnegative(),
        dailyLossRatio: z.number().finite().nonnegative(),
        weeklyDrawdownRatio: z.number().finite().nonnegative(),
      })
      .strict(),
    /** Content digest of the exact request evaluated (input snapshot id). */
    requestDigest: z.string().regex(/^[0-9a-f]{16}$/),
    activeOverrideId: z.string().regex(/^rsov_[0-9a-f]{16}$/).nullable(),
  })
  .strict()
  .refine((d) => (d.outcome === "approved" ? d.reasons.length === 0 : d.reasons.length >= 1), {
    message: "approved decisions carry no reasons; rejected decisions carry at least one",
    path: ["reasons"],
  })
  .refine(
    (d) => (d.outcome === "approved" ? d.sizedQuantityUnits > 0 : d.sizedQuantityUnits === 0),
    {
      message: "approved decisions carry a positive final size; rejected carry zero",
      path: ["sizedQuantityUnits"],
    },
  )
  .refine(
    (d) => RISK_STATES_ALLOWING_NEW_ENTRIES.includes(d.riskState) || d.outcome === "rejected",
    {
      message: "no decision may be approved in orange/red/kill",
      path: ["outcome"],
    },
  );

export type RiskDecision = z.infer<typeof riskDecisionSchema>;

/** Deterministic decision id over the canonical decision content. */
export function riskDecisionIdFor(canonicalDecisionContent: string): string {
  return `riskdec_${riskHash16(canonicalDecisionContent)}`;
}

// ---------------------------------------------------------------------------
// Canonical serializations (hash inputs; deterministic field order)
// ---------------------------------------------------------------------------

/**
 * Canonical request serialization (hash input for `requestDigest` — the
 * INPUT SNAPSHOT of record). Fixed field order, pipe-joined; pinned by
 * tests so any change is a breaking, audited change.
 */
export function serializeRiskRequestCanonical(request: RiskCheckRequest): string {
  const lvl = (v: number | null): string => (v === null ? "-" : String(v));
  const conv = (c: RiskConversionMetadata): string =>
    [c.quoteCurrency, c.accountCurrency, String(c.conversionRate), c.rateAtUtc, c.rateSource].join("~");
  const parts: string[] = [
    "rskreq",
    request.checkedAtUtc,
    request.intentId,
    request.signalId,
    request.strategyId,
    request.strategyVersion,
    request.configVersion,
    request.snapshotHash,
    request.instrument,
    request.timeframe,
    request.direction,
    request.entryType,
    lvl(request.entryPrice),
    String(request.referencePrice),
    String(request.stopLoss),
    lvl(request.takeProfit),
    request.eventTimeUtc,
    request.expiresAtUtc,
    String(request.requestedQuantityUnits),
    request.account.accountCurrency,
    String(request.account.equity),
    request.account.dayStartUtc,
    String(request.account.equityAtDayStart),
    request.account.weekStartUtc,
    String(request.account.weekPeakEquity),
    request.market.instrument,
    request.market.providerId,
    request.market.providerHealth,
    request.market.barTimeframe,
    request.market.lastClosedBarOpenUtc,
    String(request.market.observedSpreadPips),
    String(request.market.estimatedSlippagePips),
    conv(request.market.conversion),
    request.riskState,
    request.activeOverrideId ?? "-",
  ];
  for (const p of request.openPositions) {
    parts.push(
      [
        "pos",
        p.positionId,
        p.instrument,
        p.direction,
        String(p.quantityUnits),
        String(p.avgPrice),
        String(p.stopLoss),
        p.openedAtUtc,
        p.strategyId,
        conv(p.conversion),
      ].join("~"),
    );
  }
  return parts.join("|");
}

/** Canonical decision content serialization (WITHOUT decisionId). */
export function serializeRiskDecisionContentCanonical(
  decision: Omit<RiskDecision, "decisionId">,
): string {
  return [
    "rskdec",
    decision.riskEngineId,
    decision.riskEngineVersion,
    decision.riskConfigVersion,
    decision.checkedAtUtc,
    decision.intentId,
    decision.signalId,
    decision.strategyId,
    decision.instrument,
    decision.direction,
    decision.outcome,
    String(decision.sizedQuantityUnits),
    String(decision.requestedQuantityUnits),
    decision.sizeAdjusted ? "true" : "false",
    String(decision.riskAmountAccount),
    String(decision.riskFractionUsed),
    decision.reasons.join(","),
    decision.riskState,
    String(decision.utilization.portfolioHeatRatio),
    String(decision.utilization.dailyLossRatio),
    String(decision.utilization.weeklyDrawdownRatio),
    decision.requestDigest,
    decision.activeOverrideId ?? "-",
  ].join("|");
}

/** Full canonical decision serialization (with decisionId). */
export function serializeRiskDecisionCanonical(decision: RiskDecision): string {
  return `${serializeRiskDecisionContentCanonical(decision)}|${decision.decisionId}`;
}

/** Content digest of the exact request evaluated (input snapshot id). */
export function riskRequestDigestFor(request: RiskCheckRequest): string {
  return riskHash16(serializeRiskRequestCanonical(request));
}

// ---------------------------------------------------------------------------
// Hard boundary: strategy code cannot bypass the risk gate
// ---------------------------------------------------------------------------

export class RiskBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RiskBoundaryError";
  }
}

/**
 * Fail-closed boundary assertion (P11-01). The paper/demo/live orchestration
 * MUST call this with the APPROVED decision BEFORE transitioning an order
 * out of `intent` (P10 `intent -> risk_checked`). Throws when the decision
 * is not an approval for THIS intent from THIS engine in an entry-allowing
 * state with a positive final size. There is no bypass path.
 */
export function assertRiskGateCleared(
  orderLike: { intentId: string },
  decision: RiskDecision,
): void {
  if (decision.riskEngineId !== RISK_ENGINE_ID) {
    throw new RiskBoundaryError(`decision is not from ${RISK_ENGINE_ID}: ${decision.riskEngineId}`);
  }
  if (decision.intentId !== orderLike.intentId) {
    throw new RiskBoundaryError(
      `decision intent mismatch: decision ${decision.intentId} vs order ${orderLike.intentId}`,
    );
  }
  if (decision.outcome !== "approved") {
    throw new RiskBoundaryError(
      `risk gate not cleared for ${decision.intentId}: rejected (${decision.reasons.join(",")})`,
    );
  }
  if (!RISK_STATES_ALLOWING_NEW_ENTRIES.includes(decision.riskState)) {
    throw new RiskBoundaryError(
      `no new entries in risk state ${decision.riskState} (${decision.intentId})`,
    );
  }
  if (!(decision.sizedQuantityUnits > 0)) {
    throw new RiskBoundaryError(`approved decision carries no final size (${decision.intentId})`);
  }
}

