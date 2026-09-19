/**
 * Paper order state machine (P10-01, ADR-0021).
 *
 * The paper broker runs every order through an explicit, auditable lifecycle.
 * States are frozen here:
 *
 *   intent            - derived from a canonical signal (no execution).
 *   risk_checked      - passed the independent risk gate (P11 will make the
 *                       gate real; this layer only records the verdict).
 *   submitting        - being handed to the (paper) execution adapter.
 *   acknowledged      - the adapter accepted the order (working/resting).
 *   partially_filled  - at least one fill received; quantity remains.
 *   filled            - requested quantity fully filled.
 *   managed           - the position is under management (SL/TP supervision).
 *   closed            - position closed; order complete.
 *   rejected          - risk or broker rejected the order (absorbing).
 *   expired           - expired before full fill (absorbing).
 *   cancelled         - cancelled by the operator (absorbing).
 *   error             - simulation/adapter error (absorbing).
 *
 * Transitions are explicit; every event recorded by the broker must map onto
 * this table or the reconciliation loop flags `illegal_transition`. The state
 * machine is deterministic for deterministic inputs, carries no clock, and
 * never touches a broker (ADR-0003/0005 — the paper broker is a simulation).
 * All timestamps are UTC (ADR-0004).
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";

export const PAPER_BROKER_ID = "paper-broker";
export const PAPER_BROKER_VERSION = "1.0.0";

/** The full order-state vocabulary (frozen; adding a state needs an ADR). */
export const PAPER_ORDER_STATES = [
  "intent",
  "risk_checked",
  "submitting",
  "acknowledged",
  "partially_filled",
  "filled",
  "managed",
  "closed",
  "rejected",
  "expired",
  "cancelled",
  "error",
] as const;
export type PaperOrderState = (typeof PAPER_ORDER_STATES)[number];
export const paperOrderStateSchema = z.enum(PAPER_ORDER_STATES);

/** Absorbing terminal states: no transition leaves them. */
export const PAPER_TERMINAL_STATES = ["rejected", "expired", "cancelled", "error"] as const;
export type PaperTerminalState = (typeof PAPER_TERMINAL_STATES)[number];

/**
 * Explicit transition table. `partially_filled -> partially_filled` and
 * `managed -> managed` (management heartbeats) are the only self-loops:
 * repeated partial fills and repeated position_managed events are legal
 * by design.
 */
export const PAPER_ORDER_TRANSITIONS: Readonly<
  Record<PaperOrderState, readonly PaperOrderState[]>
> = Object.freeze({
  intent: ["risk_checked", "rejected"],
  risk_checked: ["submitting", "rejected"],
  submitting: ["acknowledged", "rejected", "error"],
  acknowledged: ["partially_filled", "filled", "cancelled", "expired", "error"],
  partially_filled: ["partially_filled", "filled", "cancelled", "expired", "error"],
  filled: ["managed"],
  managed: ["closed", "managed"],
  closed: [],
  rejected: [],
  expired: [],
  cancelled: [],
  error: [],
});

export class PaperOrderStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaperOrderStateError";
  }
}

/** Whether the transition is present in the frozen table. */
export function canTransitionPaperOrder(from: PaperOrderState, to: PaperOrderState): boolean {
  return PAPER_ORDER_TRANSITIONS[from].includes(to);
}

/** Fail-closed assertion: throws when the transition is illegal. */
export function assertPaperOrderTransition(from: PaperOrderState, to: PaperOrderState): void {
  if (!canTransitionPaperOrder(from, to)) {
    throw new PaperOrderStateError(
      `illegal paper order transition: ${from} -> ${to} (see PAPER_ORDER_TRANSITIONS)`,
    );
  }
}

/** Minimal structural order view the state machine needs (no full schema import → no cycles). */
export interface PaperOrderStateful {
  orderId: string;
  state: PaperOrderState;
}

/**
 * Apply one transition, returning a new minimal order-state record.
 * Deterministic for deterministic inputs; terminal states are absorbing.
 */
export function applyPaperOrderTransition(
  order: PaperOrderStateful,
  to: PaperOrderState,
  atUtc: string,
  reason?: string,
): PaperOrderStateful {
  utcInstantSchema.parse(atUtc);
  assertPaperOrderTransition(order.state, to);
  if (reason !== undefined && reason.length < 1) {
    throw new PaperOrderStateError("transition reason must be a non-empty string");
  }
  return { orderId: order.orderId, state: to };
}