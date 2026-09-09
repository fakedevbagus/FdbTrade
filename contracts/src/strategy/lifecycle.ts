/**
 * Signal lifecycle and expiry contracts (P05-06, ADR-0017).
 *
 * A signal is a STATEFUL record from emission to closure. Lifecycle states
 * frozen: `active` -> (`expired` | `invalidated` | `closed`), where
 * `closed` means consumed/managed to completion by a later execution phase
 * (P10+). Transitions are APPEND-ONLY events with deterministic UTC
 * timestamps taken from the OBSERVED bar (no wall clock — reproducible).
 *
 * Rules:
 * - A signal starts `active` at its `eventTimeUtc`.
 * - `expiry_reached`: at the first closed bar whose open time is >=
 *   `expiresAtUtc` AND the signal is still active. Expired signals are
 *   dead — never implicitly extended.
 * - `invalidation_hit`: at the first closed bar whose HIGH/LOW touched the
 *   signal's `stopLoss` while active (price-based hard invalidation; the
 *   stop level is the explicit invalidation from P05-01).
 * - `signal_closed`: terminal consumption by the execution layer; the
 *   lifecycle engine never closes on its own — closure is an input event.
 * - Transitions are idempotent: applying the same transition event twice
 *   is a no-op (the append-only log dedupes on (signalId, to, atUtc)).
 * - Terminal states are absorbing: no transition out of
 *   expired/invalidated/closed.
 * - No order creation happens here (non-goal; execution is P10+).
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";
import { signalReasonCodeSchema, signalSchema, type Signal } from "./contract";

/** Canonical lifecycle states (frozen; extension requires a new ADR). */
export const SIGNAL_LIFECYCLE_STATES = ["active", "expired", "invalidated", "closed"] as const;
export type SignalLifecycleState = (typeof SIGNAL_LIFECYCLE_STATES)[number];
export const signalLifecycleStateSchema = z.enum(SIGNAL_LIFECYCLE_STATES);

/** Terminal (absorbing) states. */
export const SIGNAL_TERMINAL_STATES: readonly SignalLifecycleState[] = Object.freeze([
  "expired",
  "invalidated",
  "closed",
]);

/**
 * One lifecycle transition. `atUtc` is the open time of the closed bar the
 * transition was decided on (deterministic — never a wall clock).
 */
export const signalTransitionSchema = z
  .object({
    signalId: z.string().min(4),
    from: signalLifecycleStateSchema,
    to: signalLifecycleStateSchema,
    atUtc: utcInstantSchema,
    /** Sorted unique reason codes explaining the transition. */
    reasonCodes: z.array(signalReasonCodeSchema).min(1),
  })
  .strict()
  .refine((t) => t.from !== t.to, { message: "from and to must differ", path: ["to"] })
  .refine(
    (t) =>
      !SIGNAL_TERMINAL_STATES.includes(t.from),
    { message: "terminal states are absorbing (no transitions out)", path: ["from"] },
  )
  .refine(
    (t) =>
      new Set(t.reasonCodes).size === t.reasonCodes.length &&
      t.reasonCodes.every((c, i) => i === 0 || c > t.reasonCodes[i - 1]),
    { message: "reasonCodes must be sorted and unique", path: ["reasonCodes"] },
  );

export type SignalTransition = z.infer<typeof signalTransitionSchema>;

/** The live lifecycle record for one signal. */
export const signalLifecycleSchema = z
  .object({
    signal: signalSchema,
    state: signalLifecycleStateSchema,
    /** Transition log, strictly ascending by atUtc, append-only. */
    transitions: z.array(signalTransitionSchema),
  })
  .strict()
  .refine(
    (l) => l.transitions.every((t, i) => i === 0 || t.atUtc > l.transitions[i - 1].atUtc),
    { message: "transitions must be strictly ascending by atUtc", path: ["transitions"] },
  )
  .refine(
    (l) => l.transitions.every((t) => t.signalId === l.signal.signalId),
    { message: "transition signalId must match the lifecycle signal", path: ["transitions"] },
  );

export type SignalLifecycle = z.infer<typeof signalLifecycleSchema>;

/** Start a lifecycle: an emitted signal begins `active` at its event bar. */
export function openLifecycle(signal: Signal): SignalLifecycle {
  return { signal, state: "active", transitions: [] };
}

/** Whether the signal is past its expiry at the given closed-bar open time. */
export function isExpiredAt(signal: Signal, barOpenUtc: string): boolean {
  return barOpenUtc >= signal.expiresAtUtc;
}

/** Whether a closed bar's range touched the invalidation (stop) level. */
export function isInvalidatedByBar(
  signal: Signal,
  bar: { high: number; low: number },
): boolean {
  return bar.high >= signal.stopLoss && bar.low <= signal.stopLoss;
}

/**
 * Deterministic lifecycle transition check for one closed bar, evaluated in
 * a fixed rule order (expiry first — an expired signal cannot also be
 * invalidated; time of death is the earlier, deterministic rule).
 * Pure: returns the transition to append, or null when none applies.
 */
export function nextTransitionForBar(
  lifecycle: SignalLifecycle,
  bar: { openTimeUtc: string; high: number; low: number },
): SignalTransition | null {
  if (lifecycle.state !== "active") {
    return null; // terminal states are absorbing
  }
  const { signal } = lifecycle;
  if (isExpiredAt(signal, bar.openTimeUtc)) {
    return {
      signalId: signal.signalId,
      from: "active",
      to: "expired",
      atUtc: bar.openTimeUtc,
      reasonCodes: ["expiry_reached"],
    };
  }
  if (isInvalidatedByBar(signal, bar)) {
    return {
      signalId: signal.signalId,
      from: "active",
      to: "invalidated",
      atUtc: bar.openTimeUtc,
      reasonCodes: ["invalidation_hit"],
    };
  }
  return null;
}

/**
 * Apply a transition (idempotent, append-only, fail-closed):
 * - validates the transition against the contract;
 * - rejects transitions out of terminal states (absorbing);
 * - dedupes on (to, atUtc): applying the same event twice is a no-op;
 * - rejects non-ascending timestamps;
 * - the resulting record re-validates against `signalLifecycleSchema`.
 */
export function applyTransition(
  lifecycle: SignalLifecycle,
  transition: SignalTransition,
): SignalLifecycle {
  const parsed = signalTransitionSchema.parse(transition);
  if (parsed.signalId !== lifecycle.signal.signalId) {
    throw new Error(
      `transition signalId ${parsed.signalId} does not match lifecycle signal ${lifecycle.signal.signalId}`,
    );
  }
  // Idempotency: the exact same event (to + atUtc) already applied -> no-op.
  const already = lifecycle.transitions.some(
    (t) => t.to === parsed.to && t.atUtc === parsed.atUtc,
  );
  if (already) {
    return lifecycle;
  }
  if (parsed.from !== lifecycle.state) {
    throw new Error(
      `transition from ${parsed.from} but lifecycle state is ${lifecycle.state}`,
    );
  }
  const last = lifecycle.transitions[lifecycle.transitions.length - 1];
  if (last && parsed.atUtc <= last.atUtc) {
    throw new Error("transitions must be strictly ascending by atUtc");
  }
  const next: SignalLifecycle = {
    ...lifecycle,
    state: parsed.to,
    transitions: [...lifecycle.transitions, parsed],
  };
  return signalLifecycleSchema.parse(next);
}

