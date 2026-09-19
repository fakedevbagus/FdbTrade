/**
 * Risk states and kill switch (P11-04, ADR-0022).
 *
 * Frozen state vocabulary:
 *
 *   green   - normal operation; new entries allowed at full risk budget.
 *   yellow  - elevated utilization; new entries allowed at a REDUCED
 *             per-trade risk budget (see stateEntryRiskFactor).
 *   orange  - utilization near caps; NO new entries (manage/close only).
 *   red     - hard utilization breach; NO new entries.
 *   kill    - KILL SWITCH (latched). Engaged ONLY by a human override and
 *             NEVER auto-reset: releasing kill requires a human action and
 *             conservatively lands in `red` (an explicit force_state is
 *             required to go lower). No strategy, AI/LLM or automated
 *             component may engage or release it (blueprint non-negotiable).
 *
 * The state is DERIVED deterministically from utilization ratios (heat,
 * daily loss, weekly drawdown vs their caps) and LATCHED by the operator
 * layer; KILL is never auto-derived. Uncertainty (stale data, provider
 * outage, unknown provider health) never lowers the state and always fails
 * closed at the decision layer (P11-02 stale/outage gates). All timestamps
 * are UTC (ADR-0004); deterministic for deterministic inputs; no wall clock
 * and no broker access (ADR-0003/0005).
 */
import { z } from "zod";

import { utcInstantSchema, type UtcInstant } from "../marketdata/time";

import { riskHash16 } from "./util";

export const RISK_ENGINE_STATES_ID = "risk-states";
export const RISK_ENGINE_STATES_VERSION = "1.0.0";

/** The full risk-state vocabulary (frozen; adding a state needs an ADR). */
export const RISK_STATES = ["green", "yellow", "orange", "red", "kill"] as const;
export type RiskState = (typeof RISK_STATES)[number];
export const riskStateSchema = z.enum(RISK_STATES);

/** States in which NEW entries may be approved (fail-closed set). */
export const RISK_STATES_ALLOWING_NEW_ENTRIES: readonly RiskState[] = Object.freeze([
  "green",
  "yellow",
]);

export class RiskStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RiskStateError";
  }
}

/** Utilization ratios (each metric / its cap). Caps are > 0, ratios >= 0. */
export interface RiskUtilizationRatios {
  portfolioHeatRatio: number;
  dailyLossRatio: number;
  weeklyDrawdownRatio: number;
}

/**
 * Deterministic state derivation from utilization ratios (KILL is NEVER
 * derived here — it is manual-only). Thresholds are frozen:
 * max ratio < 0.5 → green, < 0.75 → yellow, < 1 → orange, >= 1 → red.
 */
export function deriveRiskState(ratios: RiskUtilizationRatios): Exclude<RiskState, "kill"> {
  for (const [name, value] of Object.entries(ratios) as [keyof RiskUtilizationRatios, number][]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RiskStateError(`utilization ratio ${name} must be finite and >= 0: ${value}`);
    }
  }
  const worst = Math.max(
    ratios.portfolioHeatRatio,
    ratios.dailyLossRatio,
    ratios.weeklyDrawdownRatio,
  );
  if (worst < 0.5) return "green";
  if (worst < 0.75) return "yellow";
  if (worst < 1) return "orange";
  return "red";
}

/**
 * Per-state multiplier applied to the per-trade risk budget (P11-02 sizing).
 * `yellowRiskFactor` is configuration (defaults to 0.5); every state at or
 * above orange multiplies to 0 — no new risk is added.
 */
export function stateEntryRiskFactor(state: RiskState, yellowRiskFactor: number = 0.5): number {
  if (!Number.isFinite(yellowRiskFactor) || yellowRiskFactor <= 0 || yellowRiskFactor > 1) {
    throw new RiskStateError(`yellowRiskFactor must be in (0,1]: ${yellowRiskFactor}`);
  }
  switch (state) {
    case "green":
      return 1;
    case "yellow":
      return yellowRiskFactor;
    case "orange":
    case "red":
    case "kill":
      return 0;
  }
}


// ---------------------------------------------------------------------------
// Human overrides (kill switch engage/release, forced state)
// ---------------------------------------------------------------------------

/** Frozen override actions. Overrides change STATE only — never hard limits. */
export const RISK_OVERRIDE_ACTIONS = ["engage_kill", "release_kill", "force_state"] as const;
export type RiskOverrideAction = (typeof RISK_OVERRIDE_ACTIONS)[number];

export const riskOverrideSchema = z
  .object({
    overrideId: z.string().regex(/^rsov_[0-9a-f]{16}$/),
    action: z.enum(RISK_OVERRIDE_ACTIONS),
    /** Required for force_state; null otherwise. */
    targetState: riskStateSchema.nullable(),
    /** Human operator identity (single-user system; recorded for the audit). */
    actor: z.string().min(1).max(64),
    reason: z.string().min(1).max(512),
    atUtc: utcInstantSchema,
  })
  .strict()
  .refine((o) => o.action !== "force_state" || o.targetState !== null, {
    message: "force_state requires a targetState",
    path: ["targetState"],
  })
  .refine((o) => o.action === "force_state" || o.targetState === null, {
    message: "targetState must be null unless action is force_state",
    path: ["targetState"],
  });

export type RiskOverride = z.infer<typeof riskOverrideSchema>;

/** Deterministic override id (content-addressed; idempotent per action). */
export function riskOverrideIdFor(
  action: RiskOverrideAction,
  targetState: RiskState | null,
  actor: string,
  reason: string,
  atUtc: string,
): string {
  const content = ["rsov", action, targetState ?? "-", actor, reason, atUtc].join("|");
  return `rsov_${riskHash16(content)}`;
}

/**
 * Apply one override to the current state. Fail-closed rules:
 * - `engage_kill` always wins (any state → kill).
 * - `release_kill` is legal ONLY from `kill` and lands in `red` (the
 *   conservative non-entry state) — an explicit force_state is required to
 *   go lower. KILL is never auto-reset.
 * - `force_state` moves to any explicit target state (it still never
 *   bypasses the hard-limit checks themselves — P11-02).
 */
export function applyRiskOverride(state: RiskState, override: RiskOverride): RiskState {
  const parsed = riskOverrideSchema.parse(override);
  switch (parsed.action) {
    case "engage_kill":
      return "kill";
    case "release_kill":
      if (state !== "kill") {
        throw new RiskStateError(
          `release_kill is only legal from kill (current state: ${state}); kill is never auto-reset`,
        );
      }
      return "red";
    case "force_state":
      return parsed.targetState as RiskState;
  }
}

/**
 * Latched state tracker (pure; the operator layer owns persistence).
 * KILL is sticky: only an explicit human override moves out of it.
 */
export interface RiskStateTracker {
  state: RiskState;
  lastChangedAtUtc: UtcInstant;
  /** Override that produced the last change, when one caused it. */
  lastOverrideId: string | null;
}

export function createRiskStateTracker(
  initialState: RiskState = "green",
  atUtc: UtcInstant,
): RiskStateTracker {
  return {
    state: riskStateSchema.parse(initialState),
    lastChangedAtUtc: atUtc,
    lastOverrideId: null,
  };
}

export function reduceRiskState(
  tracker: RiskStateTracker,
  nextState: RiskState,
  atUtc: UtcInstant,
  overrideId: string | null = null,
): RiskStateTracker {
  const target = riskStateSchema.parse(nextState);
  utcInstantSchema.parse(atUtc);
  if (overrideId !== null && !/^rsov_[0-9a-f]{16}$/.test(overrideId)) {
    throw new RiskStateError(`overrideId has the wrong shape: ${overrideId}`);
  }
  if (tracker.state === target) {
    // No-op transitions are legal but never move the changed-at stamp.
    return { ...tracker };
  }
  return { state: target, lastChangedAtUtc: atUtc, lastOverrideId: overrideId };
}

/** Canonical override serialization (hash input; fixed field order). */
export function serializeRiskOverrideCanonical(override: RiskOverride): string {
  return [
    "rsov",
    override.overrideId,
    override.action,
    override.targetState ?? "-",
    override.actor,
    override.reason,
    override.atUtc,
  ].join("|");
}

/** Whether NEW entries may be approved in `state` (fail-closed elsewhere). */
export function shouldAcceptNewEntries(state: RiskState): boolean {
  return RISK_STATES_ALLOWING_NEW_ENTRIES.includes(state);
}
