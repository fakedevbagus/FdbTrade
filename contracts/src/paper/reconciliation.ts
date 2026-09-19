/**
 * Paper broker reconciliation loop (P10-04, ADR-0021).
 *
 * Compares the derived state (event-log replay + ledger + fills) against the
 * broker's append-only event log and emits ACTIONABLE discrepancy reason
 * codes — never silent fixes:
 *
 *   duplicate_event     - same eventId (content) appears twice
 *   unknown_order       - event references an order that was never created
 *   unknown_position    - position event references an unknown position
 *   out_of_order_events - event timestamps are not non-decreasing
 *   illegal_transition  - an event violates the frozen state machine (P10-01)
 *   missing_fill        - a fill_executed event has no matching fill record
 *   phantom_fill        - a fill record has no matching fill_executed event
 *   state_mismatch      - position lifecycle (open/close) disagrees with the ledger
 *   impossible_balance  - negative/hanging quantities or structurally broken ledger
 *   drift               - replaying the fills yields different cash/qty/PnL
 *
 * Deterministic for deterministic inputs; all timestamps UTC (ADR-0004); the
 * loop performs NO destructive repair (non-goal). No randomness, no clock,
 * no broker access (ADR-0003/0005).
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";
import {
  applyPaperFill,
  createPaperLedger,
  paperFillContextSchema,
  type PaperFillContext,
  type PaperLedgerState,
  paperLedgerStateSchema,
  verifyPaperLedger,
} from "./ledger";
import {
  type PaperBrokerEvent,
  type PaperFill,
  paperBrokerEventSchema,
  paperEventLogDigest,
  paperFillSchema,
  paperHash16,
} from "./order";
import { canTransitionPaperOrder, type PaperOrderState } from "./stateMachine";

export const PAPER_RECONCILIATION_ID = "paper-reconciliation";
export const PAPER_RECONCILIATION_VERSION = "1.0.0";

/** Tolerance for money/quantity comparisons during replay drift checks. */
export const PAPER_RECONCILIATION_TOLERANCE = 1e-6;

export const PAPER_DISCREPANCY_CODES = [
  "duplicate_event",
  "unknown_order",
  "unknown_position",
  "out_of_order_events",
  "illegal_transition",
  "missing_fill",
  "phantom_fill",
  "state_mismatch",
  "impossible_balance",
  "drift",
] as const;
export type PaperDiscrepancyCode = (typeof PAPER_DISCREPANCY_CODES)[number];
export const paperDiscrepancyCodeSchema = z.enum(PAPER_DISCREPANCY_CODES);

export const paperDiscrepancySchema = z
  .object({
    code: paperDiscrepancyCodeSchema,
    atUtc: utcInstantSchema.nullable(),
    orderId: z.string().nullable(),
    positionId: z.string().nullable(),
    fillId: z.string().nullable(),
    message: z.string().min(1),
  })
  .strict();

export type PaperDiscrepancy = z.infer<typeof paperDiscrepancySchema>;

export const paperReconciliationReportSchema = z
  .object({
    reconciliationId: z.string().regex(/^pbrec_[0-9a-f]{16}$/),
    ok: z.boolean(),
    atUtc: utcInstantSchema,
    eventCount: z.number().int().min(0),
    fillCount: z.number().int().min(0),
    positionCount: z.number().int().min(0),
    discrepancies: z.array(paperDiscrepancySchema),
  })
  .strict();

export type PaperReconciliationReport = z.infer<typeof paperReconciliationReportSchema>;

/** Inputs to one reconciliation pass (all derived state + the event log). */
export const paperReconciliationInputSchema = z
  .object({
    /** Append-only broker event log, time-ordered. */
    events: z.array(paperBrokerEventSchema),
    /** Derived fill records (entry + exit). */
    derivedFills: z.array(paperFillSchema),
    /** Derived ledger state. */
    derivedLedger: paperLedgerStateSchema,
    /** Per-fill context needed to replay (pipSize + conversion metadata). */
    fillContexts: z.record(z.string().min(1), paperFillContextSchema),
    /** When this reconciliation ran (caller-provided, deterministic). */
    atUtc: utcInstantSchema,
  })
  .strict();

export type PaperReconciliationInput = z.infer<typeof paperReconciliationInputSchema>;

function discrepancy(
  code: PaperDiscrepancyCode,
  event: { atUtc?: string; orderId?: string; positionId?: string; fillId?: string } | null,
  message: string,
): PaperDiscrepancy {
  return paperDiscrepancySchema.parse({
    code,
    atUtc: event?.atUtc ?? null,
    orderId: event?.orderId ?? null,
    positionId: event?.positionId ?? null,
    fillId: event?.fillId ?? null,
    message,
  });
}

/**
 * Frozen event -> allowed FROM states (mirrors PAPER_ORDER_TRANSITIONS at the
 * event granularity; keeps the state-machine table authoritative).
 */
const FROM_STATES: Readonly<Record<PaperBrokerEvent["type"], readonly PaperOrderState[]>> = {
  order_created: [],
  order_risk_checked: ["intent"],
  order_rejected: ["intent", "risk_checked", "submitting"],
  order_submitted: ["risk_checked"],
  order_acknowledged: ["submitting"],
  fill_executed: ["acknowledged", "partially_filled", "managed"],
  order_cancelled: ["acknowledged", "partially_filled"],
  order_expired: ["acknowledged", "partially_filled"],
  position_opened: ["filled"],
  position_managed: ["managed"],
  position_closed: ["managed"],
  broker_error: ["submitting", "acknowledged", "partially_filled"],
};

/** Event -> deterministic target state (used only when the from-set allows it). */
const TARGET_STATE: Readonly<Record<string, Exclude<PaperOrderState, "intent">>> = {
  order_risk_checked: "risk_checked",
  order_rejected: "rejected",
  order_submitted: "submitting",
  order_acknowledged: "acknowledged",
  order_cancelled: "cancelled",
  order_expired: "expired",
  broker_error: "error",
};

interface OrderLifecycle {
  state: PaperOrderState;
}

interface KnownPosition {
  orderId: string;
}
/**
 * Reconcile derived state against the event log. Deterministic; performs NO
 * repair. Every check emits zero or more actionable discrepancy records.
 */
export function reconcilePaperBroker(
  input: PaperReconciliationInput,
): PaperReconciliationReport {
  const parsed = paperReconciliationInputSchema.parse(input);
  const { events, derivedFills, derivedLedger, fillContexts } = parsed;
  const discrep: PaperDiscrepancy[] = [];

  // (1) Log ordering + duplicate events (content-addressed ids).
  for (let i = 1; i < events.length; i += 1) {
    if (events[i].atUtc < events[i - 1].atUtc) {
      discrep.push(
        discrepancy(
          "out_of_order_events",
          events[i],
          `event ${events[i].eventId} at ${events[i].atUtc} is before ${events[i - 1].eventId} at ${events[i - 1].atUtc}`,
        ),
      );
    }
  }
  const seenEventIds = new Set<string>();
  for (const e of events) {
    if (seenEventIds.has(e.eventId)) {
      discrep.push(discrepancy("duplicate_event", e, `event ${e.eventId} appears more than once`));
    }
    seenEventIds.add(e.eventId);
  }

  // (2) Event-log replay against the state machine.
  const createdOrders = new Map<string, OrderLifecycle>();
  const knownPositions = new Map<string, KnownPosition>();
  const applyOrderEvent = (
    orderId: string,
    e: PaperBrokerEvent,
    state: PaperOrderState,
    next: PaperOrderState,
  ): void => {
    const fromSet = FROM_STATES[e.type];
    if (!fromSet.includes(state)) {
      discrep.push(
        discrepancy(
          "illegal_transition",
          e,
          `event ${e.type} is not allowed from ${state} (requires ${fromSet.join("/")})`,
        ),
      );
      return;
    }
    if (!canTransitionPaperOrder(state, next)) {
      discrep.push(
        discrepancy("illegal_transition", e, `state machine forbids ${state} -> ${next}`),
      );
      return;
    }
    createdOrders.get(orderId)!.state = next;
  };

  for (const e of events) {
    if (e.type === "order_created") {
      if (createdOrders.has(e.orderId)) {
        discrep.push(
          discrepancy("illegal_transition", e, `order ${e.orderId} was created twice`),
        );
        continue;
      }
      createdOrders.set(e.orderId, { state: "intent" });
      continue;
    }

    let orderId: string | null = null;
    if (e.type === "position_managed" || e.type === "position_closed") {
      const pos = knownPositions.get(e.positionId);
      if (pos === undefined) {
        discrep.push(discrepancy("unknown_position", e, `unknown position ${e.positionId}`));
        continue;
      }
      orderId = pos.orderId;
    } else {
      orderId = e.orderId;
    }
    if (orderId === null || !createdOrders.has(orderId)) {
      discrep.push(
        discrepancy("unknown_order", e, `event ${e.type} references unknown order ${orderId}`),
      );
      continue;
    }

    const lifecycle = createdOrders.get(orderId)!;
    if (e.type === "position_opened") {
      applyOrderEvent(orderId, e, lifecycle.state, "managed");
      if (knownPositions.has(e.positionId)) {
        discrep.push(
          discrepancy("illegal_transition", e, `position ${e.positionId} was opened twice`),
        );
        continue;
      }
      knownPositions.set(e.positionId, { orderId });
      continue;
    }
    if (e.type === "position_managed") {
      applyOrderEvent(orderId, e, lifecycle.state, "managed");
      continue;
    }
    if (e.type === "position_closed") {
      applyOrderEvent(orderId, e, lifecycle.state, "closed");
      continue;
    }
    if (e.type === "fill_executed") {
      if (lifecycle.state === "managed") {
        // Exit fill while managing: the state stays managed; the position
        // closes on the position_closed event (never directly on the fill).
        applyOrderEvent(orderId, e, lifecycle.state, "managed");
        continue;
      }
      const next =
        e.remainingQuantityUnits <= PAPER_RECONCILIATION_TOLERANCE ? "filled" : "partially_filled";
      applyOrderEvent(orderId, e, lifecycle.state, next);
      continue;
    }
    // Order-level events map onto the frozen table (order_created handled above).
    const orderNext = TARGET_STATE[e.type];
    if (orderNext !== undefined) {
      applyOrderEvent(orderId, e, lifecycle.state, orderNext);
    }
  }

  // (3) Fill matching: events vs derived fill records (both directions).
  const eventFillIds = new Set<string>();
  for (const e of events) {
    if (e.type === "fill_executed") eventFillIds.add(e.fillId);
  }
  const derivedFillIds = new Set<string>(derivedFills.map((f) => f.fillId));
  for (const fillId of eventFillIds) {
    if (!derivedFillIds.has(fillId)) {
      discrep.push(
        discrepancy(
          "missing_fill",
          null,
          `fill_executed event references fill ${fillId} that has no record`,
        ),
      );
    }
  }
  for (const fillId of derivedFillIds) {
    if (!eventFillIds.has(fillId)) {
      discrep.push(
        discrepancy("phantom_fill", null, `fill record ${fillId} has no fill_executed event`),
      );
    }
  }

  // (4) Position lifecycle vs the derived ledger (state mismatch).
  const derivedById = new Map<string, PaperLedgerState["positions"][number]>();
  for (const p of derivedLedger.positions) derivedById.set(p.positionId, p);
  for (const e of events) {
    if (e.type !== "position_opened" && e.type !== "position_closed") continue;
    const pos = derivedById.get(e.positionId);
    if (pos === undefined) {
      discrep.push(
        discrepancy(
          "state_mismatch",
          e,
          `event ${e.type} for ${e.positionId} but the ledger has no such position`,
        ),
      );
      continue;
    }
    if (e.type === "position_closed" && pos.status !== "closed") {
      discrep.push(
        discrepancy(
          "state_mismatch",
          e,
          `position_closed event but ledger position ${e.positionId} is ${pos.status}`,
        ),
      );
    }
  }

  // (5) Impossible balances: structural ledger sanity (never silently repaired).
  for (const problem of verifyPaperLedger(derivedLedger)) {
    discrep.push(discrepancy("impossible_balance", null, `ledger problem: ${problem}`));
  }

  // (6) Drift: replay derived fills into a scratch ledger and compare.
  let scratch = createPaperLedger(derivedLedger.accountCurrency, derivedLedger.initialCash);
  for (const f of derivedFills) {
    const ctx = fillContexts[f.fillId];
    if (ctx === undefined) {
      discrep.push(
        discrepancy("drift", null, `no fill context for fill ${f.fillId} (cannot replay)`),
      );
      continue;
    }
    try {
      scratch = applyPaperFill(scratch, f, ctx);
    } catch (err) {
      discrep.push(
        discrepancy(
          "impossible_balance",
          null,
          `replaying fill ${f.fillId} failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }
  if (Math.abs(scratch.cash - derivedLedger.cash) > PAPER_RECONCILIATION_TOLERANCE) {
    discrep.push(
      discrepancy("drift", null, `cash drift: replay=${scratch.cash} derived=${derivedLedger.cash}`),
    );
  }
  if (
    Math.abs(scratch.realizedPnlTotalAccount - derivedLedger.realizedPnlTotalAccount) >
    PAPER_RECONCILIATION_TOLERANCE
  ) {
    discrep.push(
      discrepancy(
        "drift",
        null,
        `realized PnL drift: replay=${scratch.realizedPnlTotalAccount} derived=${derivedLedger.realizedPnlTotalAccount}`,
      ),
    );
  }
  if (
    Math.abs(scratch.feesTotalAccount - derivedLedger.feesTotalAccount) >
    PAPER_RECONCILIATION_TOLERANCE
  ) {
    discrep.push(
      discrepancy(
        "drift",
        null,
        `fees drift: replay=${scratch.feesTotalAccount} derived=${derivedLedger.feesTotalAccount}`,
      ),
    );
  }
  const replayByKey = new Map<string, { qty: number; avg: number; realized: number }>();
  for (const p of scratch.positions) {
    replayByKey.set(`${p.instrument}|${p.direction}`, {
      qty: p.quantityUnits,
      avg: p.avgPrice ?? 0,
      realized: p.realizedPnlQuote,
    });
  }
  const derivedByKey = new Map<string, { qty: number; avg: number; realized: number }>();
  for (const p of derivedLedger.positions) {
    derivedByKey.set(`${p.instrument}|${p.direction}`, {
      qty: p.quantityUnits,
      avg: p.avgPrice ?? 0,
      realized: p.realizedPnlQuote,
    });
  }
  const keys = new Set([...replayByKey.keys(), ...derivedByKey.keys()]);
  for (const key of keys) {
    const r = replayByKey.get(key);
    const d = derivedByKey.get(key);
    if (r === undefined || d === undefined) {
      discrep.push(
        discrepancy("drift", null, `position ${key} exists in replay but not derived (or vice versa)`),
      );
      continue;
    }
    if (
      Math.abs(r.qty - d.qty) > PAPER_RECONCILIATION_TOLERANCE ||
      Math.abs(r.avg - d.avg) > PAPER_RECONCILIATION_TOLERANCE ||
      Math.abs(r.realized - d.realized) > PAPER_RECONCILIATION_TOLERANCE
    ) {
      discrep.push(
        discrepancy(
          "drift",
          null,
          `position ${key} drift: replay(qty=${r.qty} avg=${r.avg} pnl=${r.realized}) derived(qty=${d.qty} avg=${d.avg} pnl=${d.realized})`,
        ),
      );
    }
  }

  const digest = paperEventLogDigest(events);
  return paperReconciliationReportSchema.parse({
    reconciliationId: `pbrec_${paperHash16(`${parsed.atUtc}|${digest}|${derivedLedger.cash}|${derivedLedger.equity}`)}`,
    ok: discrep.length === 0,
    atUtc: parsed.atUtc,
    eventCount: events.length,
    fillCount: derivedFills.length,
    positionCount: derivedLedger.positions.length,
    discrepancies: discrep,
  });
}

