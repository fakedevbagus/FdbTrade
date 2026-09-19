/**
 * Paper broker order/fill/event contracts (P10-01, ADR-0021).
 *
 * Shared data model for the paper broker: the `PaperOrder` (derived from a
 * canonical `BacktestOrderIntent` — full signal lineage preserved), the
 * per-fill record, the fill policy, the append-only broker event log, the
 * deterministic ids and the canonical serializations used for hashing and
 * golden-fixture pinning.
 *
 * Semantics frozen here:
 * - The paper broker NEVER contacts an execution layer; fills come from the
 *   deterministic simulator (P10-02) over CLOSED bars only (no look-ahead).
 * - Costs (spread/slippage/commission) are recorded per fill in pips and
 *   applied adversarially; commission is charged per side, never implicit.
 * - `eventId`/`fillId` are content-addressed (deterministic `paperHash16` of
 *   the canonical content) so duplicate events are detectable (P10-04).
 * - All timestamps are UTC (ADR-0004); deterministic for deterministic
 *   inputs; no randomness, no wall clock.
 */
import { z } from "zod";

import { backtestCostBreakdownSchema, type BacktestOrderIntent } from "../backtest/contract";
import { featureVersionSchema } from "../feature/definition";
import { instrumentIdSchema } from "../marketdata/instrument";
import { TIMEFRAME_MS, timeframeSchema, utcInstantSchema } from "../marketdata/time";
import { signalDirectionSchema, signalEntryTypeSchema } from "../strategy/contract";

import { paperOrderStateSchema, type PaperOrderState } from "./stateMachine";
// ---------------------------------------------------------------------------
// Identity helpers / deterministic hashing (byte-identical with Python mirror)
// ---------------------------------------------------------------------------

/**
 * FNV-1a 64-bit over UTF-16 code units (`charCodeAt`, same approach as the
 * P09 stress hash) → 16 lowercase hex chars. Deterministic in TS and Python;
 * pinned by the golden fixture so any divergence fails CI.
 */
export function paperHash16(text: string): string {
  const mask = (1n << 64n) - 1n;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Deterministic paper order id for one intent. */
export function paperOrderIdFor(intentId: string): string {
  return `pbord_${intentId}`;
}

/** Deterministic fill id: `pbfill_` + content hash (collision-safe, replayable). */
export function paperFillIdFor(
  orderId: string,
  seq: number,
  atUtc: string,
  side: "entry" | "exit",
  price: number,
  quantityUnits: number,
): string {
  const content = `${orderId}|${seq}|${atUtc}|${side}|${String(price)}|${String(quantityUnits)}`;
  return `pbfill_${paperHash16(content)}`;
}

// ---------------------------------------------------------------------------
// Order types / rejection reasons / exit reasons
// ---------------------------------------------------------------------------

/** Entry styles the simulator understands (mirrors the signal entry types). */
export const PAPER_ORDER_TYPES = ["market", "limit", "stop"] as const;
export type PaperOrderType = (typeof PAPER_ORDER_TYPES)[number];
export const paperOrderTypeSchema = z.enum(PAPER_ORDER_TYPES);

/**
 * Machine-readable rejection reasons (P10-02 simulator + broker orchestration).
 * `risk_rejected` is the only reason produced outside the simulator (the risk
 * gate); everything else comes from deterministic simulation conditions.
 */
export const PAPER_REJECT_REASONS = [
  "risk_rejected",
  "invalid_order",
  "expired_before_submit",
  "no_latency_bars",
  "expired_unfilled",
  "simulation_error",
] as const;
export type PaperRejectReason = (typeof PAPER_REJECT_REASONS)[number];
export const paperRejectReasonSchema = z.enum(PAPER_REJECT_REASONS);

/** Position close reasons in the paper broker (P10-02 managed exit). */
export const PAPER_EXIT_REASONS = ["stop", "target", "end_of_simulation"] as const;
export type PaperExitReason = (typeof PAPER_EXIT_REASONS)[number];
export const paperExitReasonSchema = z.enum(PAPER_EXIT_REASONS);

/** Fill sides: `entry` opens/adds, `exit` closes/reduces a position. */
export const PAPER_FILL_SIDES = ["entry", "exit"] as const;
export type PaperFillSide = (typeof PAPER_FILL_SIDES)[number];
export const paperFillSideSchema = z.enum(PAPER_FILL_SIDES);
// ---------------------------------------------------------------------------
// Paper order
// ---------------------------------------------------------------------------

/**
 * A paper order: full signal lineage plus broker lifecycle. Built by
 * `paperOrderFromIntent`; `state` starts at `intent` (P10-01).
 */
export const paperOrderSchema = z
  .object({
    orderId: z.string().regex(/^pbord_[A-Za-z0-9._:-]+$/),
    /** Lineage: the source signal's intent (P08 contract). */
    intentId: z.string().min(4),
    signalId: z.string().min(4),
    strategyId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    strategyVersion: featureVersionSchema,
    configVersion: featureVersionSchema,
    snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
    instrument: instrumentIdSchema,
    timeframe: timeframeSchema,
    direction: signalDirectionSchema,
    orderType: paperOrderTypeSchema,
    quantityUnits: z.number().finite().positive(),
    /** Required for limit/stop; null for market. */
    entryPrice: z.number().finite().positive().nullable(),
    /** Managed-exit levels (the broker supervises the open position). */
    stopLoss: z.number().finite().positive(),
    takeProfit: z.number().finite().positive().nullable(),
    referencePrice: z.number().finite().positive(),
    createdAtUtc: utcInstantSchema,
    expiresAtUtc: utcInstantSchema,
    /** Simulated broker latency, in bars (>= 1; zero-latency is invalid). */
    latencyBars: z.number().int().min(1),
    state: paperOrderStateSchema,
  })
  .strict()
  .refine(
    (o) => {
      const createdMs = Date.parse(o.createdAtUtc);
      const expiresMs = Date.parse(o.expiresAtUtc);
      return (
        expiresMs > createdMs &&
        (expiresMs - createdMs) % TIMEFRAME_MS[o.timeframe] === 0 &&
        createdMs % TIMEFRAME_MS[o.timeframe] === 0
      );
    },
    {
      message: "createdAtUtc/expiresAtUtc must be after/on the timeframe grid",
      path: ["expiresAtUtc"],
    },
  )
  .refine((o) => o.orderType === "market" || o.entryPrice !== null, {
    message: "limit/stop orders require an entryPrice",
    path: ["entryPrice"],
  })
  .refine(
    (o) => {
      const ref = o.entryPrice ?? o.referencePrice;
      if (o.stopLoss === ref) return false;
      if (o.takeProfit !== null && o.takeProfit === o.stopLoss) return false;
      if (o.direction === "long") {
        return o.stopLoss < ref && (o.takeProfit === null || o.takeProfit > ref);
      }
      return o.stopLoss > ref && (o.takeProfit === null || o.takeProfit < ref);
    },
    { message: "levels must be direction-consistent", path: ["stopLoss"] },
  );

export type PaperOrder = z.infer<typeof paperOrderSchema>;

/**
 * Derive the paper order from a backtest order intent: same lineage, same
 * levels, same expiry; `orderType` mirrors `entryType`, `createdAtUtc` is the
 * signal's bar open time (deterministic), latency from the fill policy.
 * The order starts in `intent` — nothing has been submitted anywhere.
 */
export function paperOrderFromIntent(
  intent: BacktestOrderIntent,
  latencyBars: number,
): PaperOrder {
  const orderType: PaperOrderType = intent.entryType;
  return paperOrderSchema.parse({
    orderId: paperOrderIdFor(intent.intentId),
    intentId: intent.intentId,
    signalId: intent.signalId,
    strategyId: intent.strategyId,
    strategyVersion: intent.strategyVersion,
    configVersion: intent.configVersion,
    snapshotHash: intent.snapshotHash,
    instrument: intent.instrument,
    timeframe: intent.timeframe,
    direction: intent.direction,
    orderType,
    quantityUnits: intent.quantityUnits,
    entryPrice: intent.entryPrice,
    stopLoss: intent.stopLoss,
    takeProfit: intent.takeProfit,
    referencePrice: intent.referencePrice,
    createdAtUtc: intent.eventTimeUtc,
    expiresAtUtc: intent.expiresAtUtc,
    latencyBars,
    state: "intent",
  });
}
// ---------------------------------------------------------------------------
// Fill record / fill policy
// ---------------------------------------------------------------------------

/** One executed fill (entry or exit) with its cost breakdown, in pips. */
export const paperFillSchema = z
  .object({
    fillId: z.string().regex(/^pbfill_[0-9a-f]{16}$/),
    orderId: z.string().regex(/^pbord_[A-Za-z0-9._:-]+$/),
    /** 1-based fill sequence per order (deterministic replay order). */
    seq: z.number().int().min(1),
    side: paperFillSideSchema,
    /** Self-describing instrument/direction (needed by the P10-03 ledger). */
    instrument: instrumentIdSchema,
    direction: signalDirectionSchema,
    /** Bar OPEN time (UTC) of the bar that triggered the fill. */
    atUtc: utcInstantSchema,
    /** Index of the trigger bar in the input cascade (for reconciliation). */
    barIndex: z.number().int().min(0),
    /** Raw trigger price (bar open / resting level) BEFORE cost adjustment. */
    triggerPrice: z.number().finite().positive(),
    /** Effective fill price AFTER adverse cost adjustment. */
    price: z.number().finite().positive(),
    quantityUnits: z.number().finite().positive(),
    costs: backtestCostBreakdownSchema,
    /** Quantity still unfilled after this fill (0 = order complete). */
    remainingQuantityUnits: z.number().finite().nonnegative(),
  })
  .strict();

export type PaperFill = z.infer<typeof paperFillSchema>;

/** Fill/cost policy of the paper broker (deterministic simulator input). */
export const paperFillPolicySchema = z
  .object({
    policyId: z.literal("paper-realistic"),
    latencyBars: z.number().int().min(1),
    spreadPips: z.number().finite().nonnegative(),
    slippagePips: z.number().finite().nonnegative(),
    commissionPips: z.number().finite().nonnegative(),
    /** Per-bar cap on the fraction of the ORIGINAL request that can fill. */
    maxFillFraction: z.number().finite().gt(0).lte(1),
  })
  .strict();

export type PaperFillPolicy = z.infer<typeof paperFillPolicySchema>;
// ---------------------------------------------------------------------------
// Broker event log (append-only; consumed by P10-04 reconciliation)
// ---------------------------------------------------------------------------

export const PAPER_BROKER_EVENT_TYPES = [
  "order_created",
  "order_risk_checked",
  "order_rejected",
  "order_submitted",
  "order_acknowledged",
  "fill_executed",
  "order_cancelled",
  "order_expired",
  "position_opened",
  "position_managed",
  "position_closed",
  "broker_error",
] as const;
export type PaperBrokerEventType = (typeof PAPER_BROKER_EVENT_TYPES)[number];
export const paperBrokerEventTypeSchema = z.enum(PAPER_BROKER_EVENT_TYPES);

/** Append-only event-log id shape (`pbevt_` + 16 hex). */
export const paperEventIdSchema = z.string().regex(/^pbevt_[0-9a-f]{16}$/);

/** Position id shape used by lifecycle events. */
export const paperPositionIdSchema = z.string().regex(/^pbpos_[A-Za-z0-9._:-]+$/);
export const paperBrokerEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("order_created"),
      eventId: paperEventIdSchema,
      atUtc: utcInstantSchema,
      orderId: z.string().regex(/^pbord_[A-Za-z0-9._:-]+$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("order_risk_checked"),
      eventId: paperEventIdSchema,
      atUtc: utcInstantSchema,
      orderId: z.string().regex(/^pbord_[A-Za-z0-9._:-]+$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("order_rejected"),
      eventId: paperEventIdSchema,
      atUtc: utcInstantSchema,
      orderId: z.string().regex(/^pbord_[A-Za-z0-9._:-]+$/),
      reason: paperRejectReasonSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("order_submitted"),
      eventId: paperEventIdSchema,
      atUtc: utcInstantSchema,
      orderId: z.string().regex(/^pbord_[A-Za-z0-9._:-]+$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("order_acknowledged"),
      eventId: paperEventIdSchema,
      atUtc: utcInstantSchema,
      orderId: z.string().regex(/^pbord_[A-Za-z0-9._:-]+$/),
      /** True when the order rests (limit/stop); false for market working orders. */
      resting: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("fill_executed"),
      eventId: paperEventIdSchema,
      atUtc: utcInstantSchema,
      orderId: z.string().regex(/^pbord_[A-Za-z0-9._:-]+$/),
      fillId: z.string().regex(/^pbfill_[0-9a-f]{16}$/),
      side: paperFillSideSchema,
      quantityUnits: z.number().finite().positive(),
      price: z.number().finite().positive(),
      costs: backtestCostBreakdownSchema,
      remainingQuantityUnits: z.number().finite().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("order_cancelled"),
      eventId: paperEventIdSchema,
      atUtc: utcInstantSchema,
      orderId: z.string().regex(/^pbord_[A-Za-z0-9._:-]+$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("order_expired"),
      eventId: paperEventIdSchema,
      atUtc: utcInstantSchema,
      orderId: z.string().regex(/^pbord_[A-Za-z0-9._:-]+$/),
      remainingQuantityUnits: z.number().finite().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("position_opened"),
      eventId: paperEventIdSchema,
      atUtc: utcInstantSchema,
      positionId: paperPositionIdSchema,
      orderId: z.string().regex(/^pbord_[A-Za-z0-9._:-]+$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("position_managed"),
      eventId: paperEventIdSchema,
      atUtc: utcInstantSchema,
      positionId: paperPositionIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("position_closed"),
      eventId: paperEventIdSchema,
      atUtc: utcInstantSchema,
      positionId: paperPositionIdSchema,
      exitPrice: z.number().finite().positive(),
      exitReason: paperExitReasonSchema,
      realizedPnl: z.number().finite(),
    })
    .strict(),
  z
    .object({
      type: z.literal("broker_error"),
      eventId: paperEventIdSchema,
      atUtc: utcInstantSchema,
      orderId: z.string().regex(/^pbord_[A-Za-z0-9._:-]+$/),
      message: z.string().min(1),
    })
    .strict(),
]);
export type PaperBrokerEvent = z.infer<typeof paperBrokerEventSchema>;
// ---------------------------------------------------------------------------
// Canonical serializations (hash inputs; byte-identical with quant/papercore)
// ---------------------------------------------------------------------------

/** Canonical order serialization (fixed field order, pipe-joined). */
export function serializePaperOrderCanonical(order: PaperOrder): string {
  const lvl = (v: number | null): string => (v === null ? "-" : String(v));
  return [
    "pbord",
    order.orderId,
    order.intentId,
    order.signalId,
    order.strategyId,
    order.strategyVersion,
    order.configVersion,
    order.snapshotHash,
    order.instrument,
    order.timeframe,
    order.direction,
    order.orderType,
    String(order.quantityUnits),
    lvl(order.entryPrice),
    String(order.stopLoss),
    lvl(order.takeProfit),
    String(order.referencePrice),
    order.createdAtUtc,
    order.expiresAtUtc,
    String(order.latencyBars),
    order.state,
  ].join("|");
}

/** Canonical fill serialization (per-fill costs inline). */
export function serializePaperFillCanonical(fill: PaperFill): string {
  return [
    "pbfill",
    fill.fillId,
    fill.orderId,
    String(fill.seq),
    fill.side,
    fill.instrument,
    fill.direction,
    fill.atUtc,
    String(fill.barIndex),
    String(fill.triggerPrice),
    String(fill.price),
    String(fill.quantityUnits),
    String(fill.costs.spreadPips),
    String(fill.costs.slippagePips),
    String(fill.costs.commissionPips),
    String(fill.remainingQuantityUnits),
  ].join("|");
}

/** Canonical fill-policy serialization. */
export function serializePaperFillPolicyCanonical(policy: PaperFillPolicy): string {
  return [
    "pbpol",
    policy.policyId,
    String(policy.latencyBars),
    String(policy.spreadPips),
    String(policy.slippagePips),
    String(policy.commissionPips),
    String(policy.maxFillFraction),
  ].join("|");
}

/**
 * Canonical event serialization WITHOUT the eventId (the id hashes this
 * content). Exported so the broker can stamp deterministic content-addressed
 * ids that the Python mirror reproduces byte-for-byte.
 */
export function serializePaperEventContentCanonical(event: PaperBrokerEvent): string {
  const prefix = ["pbevt", event.type, event.atUtc];
  switch (event.type) {
    case "order_created":
    case "order_risk_checked":
    case "order_submitted":
    case "order_cancelled":
      return [...prefix, event.orderId].join("|");
    case "order_rejected":
      return [...prefix, event.orderId, event.reason].join("|");
    case "order_acknowledged":
      return [...prefix, event.orderId, event.resting ? "true" : "false"].join("|");
    case "fill_executed":
      return [
        ...prefix,
        event.orderId,
        event.fillId,
        event.side,
        String(event.quantityUnits),
        String(event.price),
        String(event.costs.spreadPips),
        String(event.costs.slippagePips),
        String(event.costs.commissionPips),
        String(event.remainingQuantityUnits),
      ].join("|");
    case "order_expired":
      return [...prefix, event.orderId, String(event.remainingQuantityUnits)].join("|");
    case "position_opened":
      return [...prefix, event.positionId, event.orderId].join("|");
    case "position_managed":
      return [...prefix, event.positionId].join("|");
    case "position_closed":
      return [
        ...prefix,
        event.positionId,
        String(event.exitPrice),
        event.exitReason,
        String(event.realizedPnl),
      ].join("|");
    case "broker_error":
      return [...prefix, event.orderId, event.message].join("|");
  }
}

/** Full canonical event serialization (with eventId) for log digests. */
export function serializePaperEventCanonical(event: PaperBrokerEvent): string {
  return `${serializePaperEventContentCanonical(event)}|${event.eventId}`;
}

/** Deterministic event id: `pbevt_` + FNV-1a64 hash of the content. */
export function paperEventIdFor(event: PaperBrokerEvent): string {
  return `pbevt_${paperHash16(serializePaperEventContentCanonical(event))}`;
}

/** Canonical event-log digest (newline-joined full serializations). */
export function paperEventLogDigest(events: readonly PaperBrokerEvent[]): string {
  return paperHash16(`evlog|${events.map(serializePaperEventCanonical).join("\n")}`);
}