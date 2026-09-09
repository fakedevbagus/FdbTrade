/**
 * Strategy interface and canonical signal contract v2 (P05-01, ADR-0017).
 *
 * A Signal is the ONLY object a strategy may emit downstream. It is a pure,
 * deterministic record derived from an input snapshot: no wall clock, no
 * randomness, no broker access (ADR-0003 boundaries; live execution OFF,
 * ADR-0005). Every signal carries full lineage (strategy id + logic semver +
 * config semver + the exact feature inputs used) and explicit validity
 * (`expiresAtUtc` — after expiry a signal is dead, never implicitly live).
 *
 * Semantics frozen here:
 * - `eventTimeUtc` is the OPEN time of the last CLOSED bar the signal was
 *   computed from (CANDLE_TIMESTAMP_SEMANTICS); computation used bars
 *   [0..last] only — no look-ahead (proven by tests, not asserted).
 * - `confidence` is a strategy-certainty score in [0,1] — NEVER a win
 *   probability and never a profit guarantee (blueprint non-negotiables).
 * - `signalId` is the deterministic identity
 *   `sig_{strategyId}_{instrument}_{timeframe}_{eventTimeUtc}_{direction}`:
 *   one strategy emits at most one signal per (bar, direction) — idempotent
 *   re-evaluation of the same snapshot yields the same id.
 * - `snapshotHash` is sha256 of `serializeSignalCanonical` (computed by the
 *   backend builder / Python mirror; validated as lowercase hex here).
 * - Levels are direction-consistent: long => stopLoss below and takeProfit
 *   above the effective reference (entryPrice ?? referencePrice); short is
 *   the mirror. `stop`/`limit` entries require an explicit `entryPrice`.
 * - `expiresAtUtc` is strictly after `eventTimeUtc` and aligned to the
 *   timeframe grid (expiry lands on a bar-open boundary).
 */
import { z } from "zod";

import { featureVersionSchema } from "../feature/definition";
import { instrumentIdSchema } from "../marketdata/instrument";
import { TIMEFRAME_MS, timeframeSchema, utcInstantSchema } from "../marketdata/time";

/** Tradeable signal directions (a signal is an entry intent, never a hold). */
export const SIGNAL_DIRECTIONS = ["long", "short"] as const;
export type SignalDirection = (typeof SIGNAL_DIRECTIONS)[number];
export const signalDirectionSchema = z.enum(SIGNAL_DIRECTIONS);

/** Entry styles: market at next bar, or a resting stop/limit level. */
export const SIGNAL_ENTRY_TYPES = ["market", "stop", "limit"] as const;
export type SignalEntryType = (typeof SIGNAL_ENTRY_TYPES)[number];
export const signalEntryTypeSchema = z.enum(SIGNAL_ENTRY_TYPES);

/**
 * Machine-readable evidence / rejection reason codes shared by signals,
 * strategy evaluations and (P05-06) the signal lifecycle. Sorted
 * lexicographically and deduplicated on the wire.
 */
export const SIGNAL_REASON_CODES = [
  "adx_filter_passed",
  "adx_filter_rejected",
  "confirmation_passed",
  "confirmation_rejected",
  "edge_above_costs",
  "edge_below_costs",
  "ema_stack_aligned",
  "ema_stack_misaligned",
  "exhaustion_detected",
  "expiry_reached",
  "insufficient_history",
  "invalidation_hit",
  "missing_input",
  "mtf_alignment_confirmed",
  "mtf_alignment_rejected",
  "no_setup",
  "pullback_confirmed",
  "range_breakout",
  "regime_filter_passed",
  "regime_filter_rejected",
  "reversion_confirmed",
  "signal_closed",
  "signal_emitted",
  "volatility_filter_passed",
  "volatility_filter_rejected",
  "zscore_overextension",
] as const;
export type SignalReasonCode = (typeof SIGNAL_REASON_CODES)[number];
export const signalReasonCodeSchema = z.enum(SIGNAL_REASON_CODES);

/** Strategy identity: kebab-case, e.g. `trend-mtf-pullback`. */
export const strategyIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "strategyId must be kebab-case");

/** Positive finite price. */
const price = z.number().finite().positive();


/**
 * Transaction-cost inputs (blueprint: costs are mandatory where applicable).
 * Values are in pips at this layer — the P8 backtest owns the full
 * spread/slippage/latency model; strategies only use them for the
 * cost-aware minimum-edge check (P05-05).
 */
export const strategyCostModelSchema = z
  .object({
    spreadPips: z.number().finite().nonnegative(),
    slippagePips: z.number().finite().nonnegative(),
  })
  .strict();
export type StrategyCostModel = z.infer<typeof strategyCostModelSchema>;

/** Feature/evidence inputs a signal was derived from (id -> number|boolean|null). */
export const signalInputsSchema = z.record(
  z.string().min(1),
  z.union([z.number(), z.boolean(), z.null()]),
);
export type SignalInputs = z.infer<typeof signalInputsSchema>;

/** Deterministic signal identity (see module doc). */
export function signalIdFor(signal: {
  strategyId: string;
  instrument: string;
  timeframe: string;
  eventTimeUtc: string;
  direction: SignalDirection;
}): string {
  return [
    "sig",
    signal.strategyId,
    signal.instrument,
    signal.timeframe,
    signal.eventTimeUtc,
    signal.direction,
  ].join("_");
}

export const signalSchema = z
  .object({
    signalId: z.string().min(4),
    instrument: instrumentIdSchema,
    timeframe: timeframeSchema,
    /** Bar OPEN time (UTC) of the last closed bar the signal derives from. */
    eventTimeUtc: utcInstantSchema,
    direction: signalDirectionSchema,
    strategyId: strategyIdSchema,
    /** Semver of the strategy LOGIC that produced this signal. */
    strategyVersion: featureVersionSchema,
    /** Semver of the strategy CONFIG used (config is versioned separately). */
    configVersion: featureVersionSchema,
    entryType: signalEntryTypeSchema,
    /** Resting level for stop/limit entries; null for market entries. */
    entryPrice: price.nullable(),
    /** Reference price the levels were computed from (last closed bar close). */
    referencePrice: price,
    /** Hard invalidation level (mandatory — a signal without a stop is invalid). */
    stopLoss: price,
    /** Optional profit target level. */
    takeProfit: price.nullable(),
    /** Validity deadline: strictly after eventTimeUtc, timeframe-aligned. */
    expiresAtUtc: utcInstantSchema,
    /** Strategy certainty in [0,1] — never a win probability. */
    confidence: z.number().min(0).max(1),
    /** Sorted, unique, non-empty reason codes. */
    reasonCodes: z.array(signalReasonCodeSchema).min(1),
    /** Exact feature/evidence inputs used (lineage). */
    inputs: signalInputsSchema,
    /** sha256 of the canonical serialization (hex, lowercase). */
    snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
    signalContractVersion: z.literal(1),
  })
  .strict()
  .refine(
    (s) =>
      s.reasonCodes.every((code, i) => i === 0 || code > s.reasonCodes[i - 1]) &&
      new Set(s.reasonCodes).size === s.reasonCodes.length,
    { message: "reasonCodes must be sorted and unique", path: ["reasonCodes"] },
  )
  .refine((s) => Date.parse(s.eventTimeUtc) % TIMEFRAME_MS[s.timeframe] === 0, {
    message: "eventTimeUtc must be aligned to the timeframe grid",
    path: ["eventTimeUtc"],
  })
  .refine(
    (s) => {
      const eventMs = Date.parse(s.eventTimeUtc);
      const expMs = Date.parse(s.expiresAtUtc);
      return expMs > eventMs && (expMs - eventMs) % TIMEFRAME_MS[s.timeframe] === 0;
    },
    {
      message: "expiresAtUtc must be after eventTimeUtc and aligned to the timeframe grid",
      path: ["expiresAtUtc"],
    },
  )
  .refine((s) => s.entryType === "market" || s.entryPrice !== null, {
    message: "stop/limit entries require an entryPrice",
    path: ["entryPrice"],
  })
  .refine(
    (s) => {
      const ref = s.entryPrice ?? s.referencePrice;
      if (s.stopLoss === ref) {
        return false;
      }
      if (s.takeProfit !== null && s.takeProfit === s.stopLoss) {
        return false;
      }
      if (s.direction === "long") {
        return s.stopLoss < ref && (s.takeProfit === null || s.takeProfit > ref);
      }
      return s.stopLoss > ref && (s.takeProfit === null || s.takeProfit < ref);
    },
    { message: "levels must be direction-consistent", path: ["stopLoss"] },
  )
  .refine((s) => s.signalId === signalIdFor(s), {
    message: "signalId must be the deterministic id of its own fields",
    path: ["signalId"],
  });

export type Signal = z.infer<typeof signalSchema>;

/**
 * Serialization input: every content field the hash covers — `snapshotHash`
 * is excluded (hash input never contains the hash). Byte-identical across
 * runs and with the Python mirror (which reimplements `String(number)` as
 * `js_number_str`, P02-05). Changing this form is a breaking change (pinned
 * by contract tests + the committed parity fixture).
 */
export type SignalContent = Omit<Signal, "snapshotHash">;

/** Canonical signal serialization for hashing (stable order, keys sorted). */
export function serializeSignalCanonical(signal: SignalContent): string {
  const lvl = (v: number | null): string => (v === null ? "-" : String(v));
  const inputStr = (v: number | boolean | null): string =>
    v === null ? "-" : typeof v === "boolean" ? (v ? "true" : "false") : String(v);
  const inputs = Object.keys(signal.inputs)
    .sort()
    .map((id) => `${id}=${inputStr(signal.inputs[id])}`)
    .join(";");
  return [
    "signal",
    signal.signalId,
    signal.instrument,
    signal.timeframe,
    signal.eventTimeUtc,
    signal.direction,
    signal.strategyId,
    signal.strategyVersion,
    signal.configVersion,
    signal.entryType,
    lvl(signal.entryPrice),
    String(signal.referencePrice),
    String(signal.stopLoss),
    lvl(signal.takeProfit),
    signal.expiresAtUtc,
    String(signal.confidence),
    signal.reasonCodes.join(";"),
    inputs,
    String(signal.signalContractVersion),
  ].join("|");
}

