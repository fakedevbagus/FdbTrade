/**
 * Provider/system health contracts (P13-04, ADR-0027).
 *
 * Typed health snapshots + EXPLICIT fail-safe behavior mapping:
 * - `HealthCheck` is one component observation (feed, queue, api, db, cache,
 *   risk) with a status (`ok|degraded|down|unknown`), a UTC observedAt, the
 *   observation value and a machine-readable reason code on non-ok.
 * - `healthSnapshot` composes checks into an overall health state; the
 *   mapping from state to fail-safe behavior is FROZEN and total:
 *   every state has an explicit `failSafeAction`. Stale or unknown data can
 *   NEVER produce `ok` (no green-by-default): a check observed longer ago
 *   than its freshness budget degrades per `stalenessFor` before the state
 *   is computed.
 * - All timestamps UTC (ADR-0004); deterministic for deterministic inputs;
 *   no wall clock inside (the observer passes `asOfUtc`); no broker access
 *   (ADR-0003/0005).
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";

import { obsAttributeRecordSchema, type ObsAttributeValue } from "./logging";
import { riskStateSchema, type RiskState } from "../risk/states";

export const HEALTH_ID = "system-health";
export const HEALTH_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Vocabulary (frozen; adding a value needs an ADR)
// ---------------------------------------------------------------------------

export const HEALTH_COMPONENTS = [
  "feed",
  "queue",
  "api",
  "db",
  "cache",
  "risk",
] as const;
export type HealthComponent = (typeof HEALTH_COMPONENTS)[number];
export const healthComponentSchema = z.enum(HEALTH_COMPONENTS);

export const HEALTH_STATUSES = ["ok", "degraded", "down", "unknown"] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];
export const healthStatusSchema = z.enum(HEALTH_STATUSES);

export const HEALTH_STATES = ["healthy", "degraded", "fail_safe"] as const;
export type HealthState = (typeof HEALTH_STATES)[number];
export const healthStateSchema = z.enum(HEALTH_STATES);

/** Reason codes (machine-readable; frozen vocabulary). */
export const HEALTH_REASON_CODES = [
  "feed_stale",
  "feed_no_data",
  "queue_backlog",
  "queue_stalled",
  "api_error_rate",
  "api_latency",
  "db_unreachable",
  "db_latency",
  "cache_unreachable",
  "cache_stale",
  "risk_state_orange",
  "risk_state_red",
  "risk_kill_engaged",
  "risk_authority_uninitialized",
  "check_stale",
  "check_missing",
] as const;
export type HealthReasonCode = (typeof HEALTH_REASON_CODES)[number];
export const healthReasonCodeSchema = z.enum(HEALTH_REASON_CODES);

// ---------------------------------------------------------------------------
// Fail-safe behavior mapping (FROZEN — the acceptance criterion)
// ---------------------------------------------------------------------------

/**
 * What the system does in each health state. `fail_safe` DENIES new entries
 * (mirrors the blueprint: external outages/stale data fail closed for new
 * entries); `degraded` allows operation at reduced risk (yellow semantics,
 * P11-02) with a visible warning; `healthy` runs normally.
 */
export const HEALTH_FAIL_SAFE_ACTIONS: Readonly<
  Record<HealthState, { denyNewEntries: boolean; reduceRisk: boolean; description: string }>
> = Object.freeze({
  healthy: Object.freeze({
    denyNewEntries: false,
    reduceRisk: false,
    description: "Normal operation; new entries allowed at full risk budget.",
  }),
  degraded: Object.freeze({
    denyNewEntries: false,
    reduceRisk: true,
    description: "Operate with elevated scrutiny; per-trade risk budget reduced (yellow).",
  }),
  fail_safe: Object.freeze({
    denyNewEntries: true,
    reduceRisk: true,
    description: "Fail closed: no new entries; manage/close only.",
  }),
});

/** The fail-safe behavior for a state (total — every state is mapped). */
export function failSafeActionFor(state: HealthState) {
  return HEALTH_FAIL_SAFE_ACTIONS[healthStateSchema.parse(state)];
}

// ---------------------------------------------------------------------------
// Health checks (one component observation)
// ---------------------------------------------------------------------------

export const healthCheckSchema = z
  .object({
    component: healthComponentSchema,
    status: healthStatusSchema,
    observedAtUtc: utcInstantSchema,
    /** Machine-readable reason code for any non-ok status (null on ok). */
    reason: healthReasonCodeSchema.nullable(),
    /** Observed metrics (redacted scalars — latencyMs, backlog, ageMs, ...). */
    metrics: obsAttributeRecordSchema,
  })
  .strict()
  .refine((c) => (c.status === "ok") === (c.reason === null), {
    message: "ok checks carry reason null; non-ok checks carry a reason code",
    path: ["reason"],
  });
export type HealthCheck = z.infer<typeof healthCheckSchema>;

export class HealthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HealthError";
  }
}

/**
 * Staleness of one check against its freshness budget: a check older than
 * `maxAgeMs` is `unknown` (data absent), older than `warnAgeMs` is
 * `degraded` via `check_stale`. Fresh checks keep their observed status.
 * This is the no-green-by-default gate: stale data can never stay `ok`.
 */
export function stalenessFor(
  check: HealthCheck,
  asOfUtc: string,
  budgets: Readonly<Record<HealthComponent, { warnAgeMs: number; maxAgeMs: number }>>,
): { status: HealthStatus; reason: HealthReasonCode | null; ageMs: number } {
  const parsed = healthCheckSchema.parse(check);
  const asOf = Date.parse(utcInstantSchema.parse(asOfUtc));
  const ageMs = asOf - Date.parse(parsed.observedAtUtc);
  const budget = budgets[parsed.component];
  if (budget === undefined) {
    throw new HealthError(`no freshness budget for component ${parsed.component}`);
  }
  if (ageMs < 0) {
    throw new HealthError(`check observed after asOfUtc (${parsed.observedAtUtc} > ${asOfUtc})`);
  }
  if (ageMs > budget.maxAgeMs) {
    return { status: "unknown", reason: "check_stale", ageMs };
  }
  if (ageMs > budget.warnAgeMs && parsed.status === "ok") {
    return { status: "degraded", reason: "check_stale", ageMs };
  }
  return { status: parsed.status, reason: parsed.reason, ageMs };
}

// ---------------------------------------------------------------------------
// Snapshot + state computation
// ---------------------------------------------------------------------------

export interface HealthSnapshotInput {
  asOfUtc: string;
  /** Current latched risk state (drives the risk check's contribution). */
  riskState: RiskState;
  checks: readonly HealthCheck[];
  /** Freshness budgets per component (required for every present component). */
  budgets: Readonly<Record<HealthComponent, { warnAgeMs: number; maxAgeMs: number }>>;
}

export interface HealthSnapshot {
  healthId: string;
  asOfUtc: string;
  state: HealthState;
  /** Explicit fail-safe behavior for the computed state. */
  failSafe: { denyNewEntries: boolean; reduceRisk: boolean; description: string };
  riskState: RiskState;
  /** Checks with staleness applied, ordered by frozen component order. */
  checks: readonly (HealthCheck & { effectiveStatus: HealthStatus; ageMs: number })[];
  /** Machine-readable reasons across non-effective-ok checks (sorted, unique). */
  reasons: readonly HealthReasonCode[];
}

/**
 * Compute the health snapshot. Deterministic for deterministic inputs.
 * Rules (frozen):
 * - Staleness is applied FIRST (no green-by-default when data is stale).
 * - `down` or `unknown` on feed/db/risk -> `fail_safe` (fail closed for new
 *   entries — blueprint non-negotiable). `down`/`unknown` on queue/api/cache
 *   alone -> `degraded` (components with safe fallbacks) unless they are the
 *   risk/feed/db spine.
 * - Any `degraded` check -> at least `degraded`.
 * - The risk check: orange -> degraded, red/kill -> fail_safe (mirrors
 *   P11-04 state semantics: no new entries at or above orange).
 * - An EMPTY check set is `fail_safe` via `check_missing` (absence of
 *   evidence is never healthy).
 */
export function computeHealthSnapshot(input: HealthSnapshotInput): HealthSnapshot {
  const asOfUtc = utcInstantSchema.parse(input.asOfUtc);
  const riskState = riskStateSchema.parse(input.riskState);
  if (input.checks.length === 0) {
    const failSafe = failSafeActionFor("fail_safe");
    return {
      healthId: HEALTH_ID,
      asOfUtc,
      state: "fail_safe",
      failSafe,
      riskState,
      checks: [],
      reasons: ["check_missing"],
    };
  }
  const effective: (HealthCheck & { effectiveStatus: HealthStatus; ageMs: number })[] = [];
  for (const check of input.checks) {
    const staleness = stalenessFor(check, asOfUtc, input.budgets);
    effective.push({
      ...check,
      // Staleness owns the effective reason when it overrides the check.
      reason: staleness.reason ?? check.reason,
      effectiveStatus: staleness.status,
      ageMs: staleness.ageMs,
    });
  }
  effective.sort(
    (a, b) =>
      HEALTH_COMPONENTS.indexOf(a.component) - HEALTH_COMPONENTS.indexOf(b.component),
  );

  const reasons = new Set<HealthReasonCode>();
  let state: HealthState = "healthy";
  for (const check of effective) {
    const status = check.effectiveStatus;
    if (status === "ok") continue;
    if (check.reason !== null) reasons.add(check.reason);
    if (status === "degraded") {
      state = state === "fail_safe" ? state : "degraded";
      continue;
    }
    // down / unknown
    if (check.component === "feed" || check.component === "db" || check.component === "risk") {
      state = "fail_safe"; // entry-spine components fail closed
    } else {
      state = state === "fail_safe" ? state : "degraded";
    }
  }
  // Risk state contributes independently of the check row (latched truth).
  if (riskState === "orange") {
    state = state === "fail_safe" ? state : "degraded";
    reasons.add("risk_state_orange");
  } else if (riskState === "red") {
    state = "fail_safe";
    reasons.add("risk_state_red");
  } else if (riskState === "kill") {
    state = "fail_safe";
    reasons.add("risk_kill_engaged");
  }
  return {
    healthId: HEALTH_ID,
    asOfUtc,
    state,
    failSafe: failSafeActionFor(state),
    riskState,
    checks: effective,
    reasons: [...reasons].sort(),
  };
}

/** Type helper for check metrics. */
export type HealthMetrics = Readonly<Record<string, ObsAttributeValue>>;
