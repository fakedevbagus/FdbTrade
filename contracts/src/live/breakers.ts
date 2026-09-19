/**
 * Live circuit breakers and rollback (P17-04, ADR-0031).
 *
 * Deterministic, auditable breakers that disable NEW ENTRIES when risk,
 * data, broker or performance thresholds breach:
 * - risk breaker: daily loss pct, drawdown pct, open risk breaches;
 * - data breaker: stale data age, provider outage, data-quality gate hits;
 * - broker breaker: broker unhealthy, order reject rate, order error rate;
 * - performance breaker: order latency, slippage.
 *
 * EXIT-MANAGEMENT PATH IS PRESERVED: a trip disables new entries only;
 * `exitManagementAvailable` stays true so positions can still be managed
 * and closed where safe. No forced liquidation (non-goal): the breaker
 * never closes positions itself.
 *
 * Rollback never deletes state: trip events are append-only
 * (`stateDeleted: false`); re-arming after a trip is an explicit,
 * actor-attributed event, never automatic.
 *
 * Deterministic: every instant and reading is caller input; UTC only.
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";

export const LIVE_BREAKER_ID = "live-circuit-breakers";
export const LIVE_BREAKER_VERSION = "1.0.0";

export class LiveBreakerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveBreakerError";
  }
}

// ---------------------------------------------------------------------------
// Breaker vocabulary (frozen; adding a value needs an ADR)
// ---------------------------------------------------------------------------

export const LIVE_BREAKER_KINDS = ["risk", "data", "broker", "performance"] as const;
export type LiveBreakerKind = (typeof LIVE_BREAKER_KINDS)[number];
export const liveBreakerKindSchema = z.enum(LIVE_BREAKER_KINDS);

/** Readings one kind watches. */
export const LIVE_BREAKER_METRICS = [
  "dailyLossPct",
  "drawdownPct",
  "riskLimitBreaches",
  "dataAgeMs",
  "providerOutage",
  "dataQualityGateHits",
  "brokerUnhealthy",
  "orderRejectRatePct",
  "orderErrorRatePct",
  "orderLatencyMs",
  "slippagePct",
] as const;
export type LiveBreakerMetric = (typeof LIVE_BREAKER_METRICS)[number];
export const liveBreakerMetricSchema = z.enum(LIVE_BREAKER_METRICS);

/** Which metrics belong to which breaker kind (frozen mapping). */
export const LIVE_BREAKER_METRIC_KINDS: Readonly<
  Record<LiveBreakerKind, readonly LiveBreakerMetric[]>
> = {
  risk: ["dailyLossPct", "drawdownPct", "riskLimitBreaches"],
  data: ["dataAgeMs", "providerOutage", "dataQualityGateHits"],
  broker: ["brokerUnhealthy", "orderRejectRatePct", "orderErrorRatePct"],
  performance: ["orderLatencyMs", "slippagePct"],
};

// ---------------------------------------------------------------------------
// Thresholds + readings
// ---------------------------------------------------------------------------

export const liveBreakerThresholdsSchema = z
  .object({
    /** Max daily loss, percent of equity, before the risk breaker trips. */
    maxDailyLossPct: z.number().min(0).max(100),
    /** Max drawdown, percent of equity, before the risk breaker trips. */
    maxDrawdownPct: z.number().min(0).max(100),
    /** Risk-limit breaches tolerated (hard limit: 0 — any breach trips). */
    maxRiskLimitBreaches: z.number().int().min(0),
    /** Max market-data age in ms before the data breaker trips. */
    maxDataAgeMs: z.number().int().min(1),
    /** Provider outage reading is boolean — true trips immediately. */
    maxProviderOutages: z.number().int().min(0),
    /** Data-quality gate hits tolerated (hard limit: 0). */
    maxDataQualityGateHits: z.number().int().min(0),
    /** Broker unhealthy reading is boolean — true trips immediately. */
    maxBrokerUnhealthy: z.number().int().min(0),
    /** Max order reject rate, percent, before the broker breaker trips. */
    maxOrderRejectRatePct: z.number().min(0).max(100),
    /** Max order error rate, percent, before the broker breaker trips. */
    maxOrderErrorRatePct: z.number().min(0).max(100),
    /** Max order latency, ms, before the performance breaker trips. */
    maxOrderLatencyMs: z.number().int().min(1),
    /** Max slippage, percent, before the performance breaker trips. */
    maxSlippagePct: z.number().min(0),
  })
  .strict();
export type LiveBreakerThresholds = z.infer<typeof liveBreakerThresholdsSchema>;

/**
 * Conservative frozen defaults; tighter than every earlier phase's
 * thresholds (demo monitor allows more — the pilot must be stricter).
 */
export const DEFAULT_LIVE_BREAKER_THRESHOLDS: LiveBreakerThresholds = Object.freeze({
  maxDailyLossPct: 1.5, // blueprint initial daily loss stop 1.5-2.0%: take the floor
  maxDrawdownPct: 2,
  maxRiskLimitBreaches: 0,
  maxDataAgeMs: 60_000,
  maxProviderOutages: 0,
  maxDataQualityGateHits: 0,
  maxBrokerUnhealthy: 0,
  maxOrderRejectRatePct: 10,
  maxOrderErrorRatePct: 10,
  maxOrderLatencyMs: 2000,
  maxSlippagePct: 0.5,
});

// ---------------------------------------------------------------------------
// Readings + trip events
// ---------------------------------------------------------------------------

/** One observed reading (metrics not watched by the kind are ignored). */
export const liveBreakerReadingSchema = z
  .object({
    kind: liveBreakerKindSchema,
    /** Metric values for the reading's kind (subset allowed). */
    values: z.record(z.string(), z.union([z.number(), z.boolean()])),
    observedAtUtc: utcInstantSchema,
  })
  .strict();
export type LiveBreakerReading = z.infer<typeof liveBreakerReadingSchema>;

export const liveBreakerTripEventSchema = z
  .object({
    /** `lbrk_` + FNV-1a64 of canonical content. */
    eventId: z.string().regex(/^lbrk_[0-9a-f]{16}$/),
    kind: liveBreakerKindSchema,
    /** The metric whose threshold was breached. */
    metric: liveBreakerMetricSchema,
    observed: z.number(),
    threshold: z.number(),
    trippedAtUtc: utcInstantSchema,
    /** New entries are disabled; exits remain available (never removed). */
    entriesDisabled: z.literal(true),
    exitManagementAvailable: z.literal(true),
    /** Rollback never deletes state. */
    stateDeleted: z.literal(false),
    /** Human re-arm attribution; null while tripped. */
    reArmedBy: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/).nullable(),
    reArmedAtUtc: utcInstantSchema.nullable(),
  })
  .strict();
export type LiveBreakerTripEvent = z.infer<typeof liveBreakerTripEventSchema>;

/** Re-arm record: explicit, actor-attributed, never automatic. */
export const liveBreakerReArmEventSchema = z
  .object({
    kind: liveBreakerKindSchema,
    reArmedBy: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
    reason: z.string().min(10).max(2000),
    reArmedAtUtc: utcInstantSchema,
  })
  .strict();
export type LiveBreakerReArmEvent = z.infer<typeof liveBreakerReArmEventSchema>;


// ---------------------------------------------------------------------------
// Threshold evaluation (pure, deterministic)
// ---------------------------------------------------------------------------

export const liveBreakerBreachSchema = z
  .object({
    kind: liveBreakerKindSchema,
    metric: liveBreakerMetricSchema,
    observed: z.number(),
    threshold: z.number(),
  })
  .strict();
export type LiveBreakerBreach = z.infer<typeof liveBreakerBreachSchema>;

/**
 * Evaluate one reading against the thresholds. Returns the FIRST breach in
 * frozen metric order (deterministic) or null. Unknown metrics for the
 * kind are rejected fail-closed (a typo must never silently pass).
 */
export function evaluateLiveBreakerReading(
  reading: LiveBreakerReading,
  thresholds: LiveBreakerThresholds,
): LiveBreakerBreach | null {
  const r = liveBreakerReadingSchema.parse(reading);
  const t = liveBreakerThresholdsSchema.parse(thresholds);
  const watched = LIVE_BREAKER_METRIC_KINDS[r.kind];
  const thresholdByMetric: Record<LiveBreakerMetric, number> = {
    dailyLossPct: t.maxDailyLossPct,
    drawdownPct: t.maxDrawdownPct,
    riskLimitBreaches: t.maxRiskLimitBreaches,
    dataAgeMs: t.maxDataAgeMs,
    providerOutage: t.maxProviderOutages,
    dataQualityGateHits: t.maxDataQualityGateHits,
    brokerUnhealthy: t.maxBrokerUnhealthy,
    orderRejectRatePct: t.maxOrderRejectRatePct,
    orderErrorRatePct: t.maxOrderErrorRatePct,
    orderLatencyMs: t.maxOrderLatencyMs,
    slippagePct: t.maxSlippagePct,
  };
  for (const metric of watched) {
    const value = r.values[metric];
    if (value === undefined) {
      continue; // reading did not carry this metric — nothing to evaluate
    }
    if (typeof value !== "number" && typeof value !== "boolean") {
      throw new LiveBreakerError(`metric '${metric}' must be number or boolean`);
    }
    const observed = typeof value === "boolean" ? (value ? 1 : 0) : value;
    const threshold = thresholdByMetric[metric];
    if (observed > threshold) {
      return { kind: r.kind, metric, observed, threshold };
    }
  }
  const unknown = Object.keys(r.values).filter((m) => !watched.includes(m as LiveBreakerMetric));
  if (unknown.length > 0) {
    throw new LiveBreakerError(
      `reading for kind '${r.kind}' carries metrics outside its vocabulary: ${unknown.join(",")}`,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Breaker panel (state machine; append-only trip history)
// ---------------------------------------------------------------------------

/** Live circuit breaker panel. Deterministic: instants are caller inputs. */
export class LiveBreakerPanel {
  private readonly thresholds: LiveBreakerThresholds;
  private readonly tripped: Map<LiveBreakerKind, LiveBreakerTripEvent>;
  private readonly history: LiveBreakerTripEvent[];

  constructor(thresholds: LiveBreakerThresholds) {
    this.thresholds = liveBreakerThresholdsSchema.parse(thresholds);
    this.tripped = new Map();
    this.history = [];
  }

  get thresholdsSnapshot(): LiveBreakerThresholds {
    return this.thresholds;
  }

  get isAnyTripped(): boolean {
    return this.tripped.size > 0;
  }

  get isRiskTripped(): boolean {
    return this.tripped.has("risk");
  }

  get isDataTripped(): boolean {
    return this.tripped.has("data");
  }

  get isBrokerTripped(): boolean {
    return this.tripped.has("broker");
  }

  get isPerformanceTripped(): boolean {
    return this.tripped.has("performance");
  }

  /** Append-only trip history (audit trail; never rewritten). */
  get tripHistory(): readonly LiveBreakerTripEvent[] {
    return [...this.history];
  }


  /**
   * Record one reading. On breach: the kind's breaker trips (idempotent —
   * the first trip event for a kind stays; repeated breaches do not
   * duplicate it), new entries become disabled, exit management stays
   * available, nothing is deleted. Returns the trip event or null.
   */
  recordReading(reading: LiveBreakerReading): LiveBreakerTripEvent | null {
    const breach = evaluateLiveBreakerReading(reading, this.thresholds);
    if (breach === null) {
      return null;
    }
    const existing = this.tripped.get(breach.kind);
    if (existing !== undefined) {
      return existing; // idempotent: breaker already tripped, first event stays
    }
    const eventId = `lbrk_${fnv1a64(
      `lbrk|${breach.kind}|${breach.metric}|${breach.observed}|${breach.threshold}|${reading.observedAtUtc}`,
    )}`;
    const event = liveBreakerTripEventSchema.parse({
      eventId,
      kind: breach.kind,
      metric: breach.metric,
      observed: breach.observed,
      threshold: breach.threshold,
      trippedAtUtc: reading.observedAtUtc,
      entriesDisabled: true,
      exitManagementAvailable: true,
      stateDeleted: false,
      reArmedBy: null,
      reArmedAtUtc: null,
    });
    this.tripped.set(breach.kind, event);
    this.history.push(event);
    return event;
  }

  /**
   * Whether a NEW ENTRY may be placed. Fail closed: any tripped breaker
   * blocks new entries. Exits are unaffected (separate path by design).
   */
  canOpenNewEntries(): { allowed: boolean; trippedKinds: LiveBreakerKind[] } {
    const kinds = [...this.tripped.keys()].sort();
    return { allowed: this.tripped.size === 0, trippedKinds: kinds };
  }

  /**
   * Exit-management availability: ALWAYS true while a session exists —
   * breakers disable new entries, they never remove the exit path.
   */
  canManageExits(): boolean {
    return true;
  }

  /**
   * Explicit, actor-attributed re-arm. The trip event in history gains the
   * re-arm attribution (a new immutable record replaces the map entry; the
   * history keeps the original). Re-arming a kind that is not tripped fails
   * closed (no silent resets).
   */
  reArm(reArm: LiveBreakerReArmEvent): LiveBreakerTripEvent | null {
    const parsed = liveBreakerReArmEventSchema.parse(reArm);
    const existing = this.tripped.get(parsed.kind);
    if (existing === undefined) {
      throw new LiveBreakerError(`breaker '${parsed.kind}' is not tripped; nothing to re-arm`);
    }
    if (Date.parse(parsed.reArmedAtUtc) <= Date.parse(existing.trippedAtUtc)) {
      throw new LiveBreakerError("re-arm instant must be after the trip instant");
    }
    const updated = liveBreakerTripEventSchema.parse({
      ...existing,
      reArmedBy: parsed.reArmedBy,
      reArmedAtUtc: parsed.reArmedAtUtc,
    });
    this.tripped.delete(parsed.kind);
    this.history.push(updated);
    return updated;
  }
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

