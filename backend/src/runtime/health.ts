/**
 * Runtime health projections (M45, ADR-0034).
 *
 * The blueprint requires projections for scheduler, queue, database, source,
 * analysis, and paper_broker. These are RUNTIME projections derived from
 * injected observations — pure, secret-free, and explicit about degradation.
 * They complement (not replace) the P13 `HealthSnapshot` components: the
 * frozen contracts component set is untouched, and the two views are joined
 * at the health API layer later.
 *
 * Fail-safe: missing observations degrade the component explicitly — a
 * projection is never fabricated green, and a suspended scheduler shows as
 * `paused` with the reason, not as a healthy idle loop.
 */

import type { DegradationLevel } from "./degradation";
import type { CycleState } from "./lease";

export const RUNTIME_HEALTH_COMPONENTS = [
  "scheduler",
  "queue",
  "database",
  "source",
  "analysis",
  "paper_broker",
] as const;
export type RuntimeHealthComponent = (typeof RUNTIME_HEALTH_COMPONENTS)[number];

export type RuntimeComponentStatus = "ok" | "degraded" | "down" | "paused";

export interface SchedulerObservation {
  state: CycleState | "stopped" | "draining";
  lastCompletedCycleId: string | null;
  consecutiveTimeouts: number;
  degradation: DegradationLevel;
  processLockHeld: boolean;
}

export interface QueueObservation {
  backlog: number;
  running: number;
}

export interface DatabaseObservation {
  status: "ok" | "unavailable";
  latencyMs: number | null;
}

export interface SourceObservation {
  providerId: string;
  stale: boolean;
  healthy: boolean;
}

export interface AnalysisObservation {
  lastAnalyzedCycleId: string | null;
  stale: boolean;
}

export interface PaperBrokerObservation {
  /** The paper execution service is reachable for OPERATOR-CONFIRMED operations. */
  available: boolean;
  /** Automatic paper execution is never enabled by the runtime scheduler. */
  automaticExecutionEnabled: false;
}

export interface RuntimeHealthInput {
  atMs: number;
  scheduler: SchedulerObservation;
  queue: QueueObservation;
  database: DatabaseObservation | null;
  source: SourceObservation | null;
  analysis: AnalysisObservation | null;
  paperBroker: PaperBrokerObservation | null;
}

export interface RuntimeHealthProjection {
  atMs: number;
  components: Record<RuntimeHealthComponent, { status: RuntimeComponentStatus; reason: string | null }>;
  overall: RuntimeComponentStatus;
}

/** Derive the runtime health projection (pure; no wall-clock reads). */
export function projectRuntimeHealth(
  input: RuntimeHealthInput,
): RuntimeHealthProjection {
  const components = {} as Record<
    RuntimeHealthComponent,
    { status: RuntimeComponentStatus; reason: string | null }
  >;

  // Scheduler: paused when suspended/degraded; down when the process lock
  // is not held (another process owns the database or startup failed).
  if (!input.scheduler.processLockHeld) {
    components.scheduler = {
      status: "down",
      reason: "process_lock_not_held",
    };
  } else if (input.scheduler.degradation === "suspended") {
    components.scheduler = { status: "paused", reason: "degradation_suspended" };
  } else if (input.scheduler.consecutiveTimeouts > 0) {
    components.scheduler = {
      status: "degraded",
      reason: "cycle_timeouts",
    };
  } else {
    components.scheduler = { status: "ok", reason: null };
  }

  // Queue: explicit budget pressure (50% of the soft limit warns).
  const queueBacklog = input.queue.backlog;
  components.queue =
    queueBacklog > 100
      ? { status: "degraded", reason: "queue_backlog_high" }
      : { status: "ok", reason: null };

  // Database: missing observation is down (fail-safe), never ok.
  components.database = input.database
    ? input.database.status === "ok"
      ? { status: "ok", reason: null }
      : { status: "down", reason: "db_unreachable" }
    : { status: "down", reason: "db_unobserved" };

  // Source (market data): stale or unhealthy feed is degraded, explicit.
  components.source = input.source
    ? !input.source.healthy
      ? { status: "down", reason: "source_unhealthy" }
      : input.source.stale
        ? { status: "degraded", reason: "source_stale" }
        : { status: "ok", reason: null }
    : { status: "degraded", reason: "source_unobserved" };

  // Analysis: stale analysis is degraded; missing observation explicit.
  components.analysis = input.analysis
    ? input.analysis.stale
      ? { status: "degraded", reason: "analysis_stale" }
      : { status: "ok", reason: null }
    : { status: "degraded", reason: "analysis_unobserved" };

  // Paper subsystem: operator-confirmed operations only; the runtime never
  // enables automatic execution, so this component reports availability.
  components.paper_broker = input.paperBroker
    ? input.paperBroker.available
      ? { status: "ok", reason: null }
      : { status: "degraded", reason: "paper_broker_unavailable" }
    : { status: "degraded", reason: "paper_broker_unobserved" };

  // Overall: worst of the components (fail-safe ordering).
  const severity: Record<RuntimeComponentStatus, number> = {
    ok: 0,
    degraded: 1,
    paused: 2,
    down: 3,
  };
  let overall: RuntimeComponentStatus = "ok";
  for (const component of Object.values(components)) {
    if (severity[component.status] > severity[overall]) {
      overall = component.status;
    }
  }

  return { atMs: input.atMs, components, overall };
}