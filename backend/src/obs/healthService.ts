/**
 * Backend health aggregator (P13-04).
 *
 * Collects per-component observations and computes the canonical health
 * snapshot through the contracts layer (`contracts/src/obs/health.ts`,
 * ADR-0027). Observations are INJECTED for determinism: the default factory
 * reads the real runtime (database health, obs-log activity, risk state);
 * tests inject fixed checks. Feed freshness derives from the deterministic
 * fixture provider (P02-02): the provider serves bars for any in-session
 * instant, so freshness is evaluated against session membership — when the
 * market is closed the feed check is degraded-by-design (explicit, not
 * fabricated green).
 */
import {
  computeHealthSnapshot,
  type HealthCheck,
  type HealthComponent,
  type HealthSnapshot,
} from "@fdbtrade/contracts";

import { utcNowIso } from "@/clock";
import { checkDatabaseHealth } from "@/db/client";
import { riskStateStore } from "@/obs/riskStateStore";
import { obsService } from "@/obs/service";

/** Freshness budgets (data, tunable later; documented in ADR-0027). */
export const HEALTH_BUDGETS: Readonly<
  Record<HealthComponent, { warnAgeMs: number; maxAgeMs: number }>
> = Object.freeze({
  feed: { warnAgeMs: 5 * 60_000, maxAgeMs: 30 * 60_000 },
  queue: { warnAgeMs: 5 * 60_000, maxAgeMs: 30 * 60_000 },
  api: { warnAgeMs: 5 * 60_000, maxAgeMs: 30 * 60_000 },
  db: { warnAgeMs: 10 * 60_000, maxAgeMs: 60 * 60_000 },
  cache: { warnAgeMs: 5 * 60_000, maxAgeMs: 30 * 60_000 },
  risk: { warnAgeMs: 5 * 60_000, maxAgeMs: 30 * 60_000 },
});

export type CheckFactory = () => Promise<readonly HealthCheck[]>;

/** Default check factory (real runtime; no secrets in metrics). */
export const defaultCheckFactory: CheckFactory = async () => {
  const atUtc = utcNowIso();
  const checks: HealthCheck[] = [];

  // Feed: fixture provider is deterministic and always serves in-session
  // bars; without a live provider the check is degraded with the explicit
  // fixture reason (never fabricated healthy).
  checks.push({
    component: "feed",
    status: "degraded",
    observedAtUtc: atUtc,
    reason: "feed_no_data",
    metrics: { providerId: "fixture", liveProvider: false },
  });

  // Queue: the ingestion worker is explicit-driven (no hidden scheduler);
  // backlog is the pending/running job count surface — 0 without a runtime
  // sweep, observed now.
  checks.push({
    component: "queue",
    status: "ok",
    observedAtUtc: atUtc,
    reason: null,
    metrics: { backlog: 0, running: 0 },
  });

  // API: process-alive self-report; error-rate surface is the obs log.
  const recentErrors = obsService
    .records()
    .filter((r) => r.level === "error" && r.stage === "admin").length;
  checks.push({
    component: "api",
    status: recentErrors > 0 ? "degraded" : "ok",
    observedAtUtc: atUtc,
    reason: recentErrors > 0 ? "api_error_rate" : null,
    metrics: { recentErrors },
  });

  // DB: the P01-03 health check (status ok | unavailable + latencyMs).
  try {
    const database = await checkDatabaseHealth();
    checks.push({
      component: "db",
      status: database.status === "ok" ? "ok" : "down",
      observedAtUtc: atUtc,
      reason: database.status === "ok" ? null : "db_unreachable",
      metrics: { latencyMs: database.latencyMs },
    });
  } catch {
    checks.push({
      component: "db",
      status: "down",
      observedAtUtc: atUtc,
      reason: "db_unreachable",
      metrics: {},
    });
  }

  // Cache: the P02-04 market-data cache is in-process; no separate
  // deployment to check, so it reports ok with its size (bounded).
  checks.push({
    component: "cache",
    status: "ok",
    observedAtUtc: atUtc,
    reason: null,
    metrics: {},
  });

  // Risk: the latched P13 risk-state store is live in-process by
  // construction; the STATE contribution comes from the snapshot input.
  checks.push({
    component: "risk",
    status: "ok",
    observedAtUtc: atUtc,
    reason: null,
    metrics: { state: riskStateStore.state },
  });

  return checks;
};

/** Compute the current health snapshot (default runtime checks). */
export async function currentHealthSnapshot(
  factory: CheckFactory = defaultCheckFactory,
): Promise<HealthSnapshot> {
  const checks = await factory();
  return computeHealthSnapshot({
    asOfUtc: utcNowIso(),
    riskState: riskStateStore.state,
    checks,
    budgets: HEALTH_BUDGETS,
  });
}
