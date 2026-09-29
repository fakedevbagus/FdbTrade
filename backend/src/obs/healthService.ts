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
import { checkDatabaseHealth, getDatabase } from "@/db/client";
import { MARKET_DATA_ARTIFACT_ROOT } from "@/data/historical/storeDir";
import { durableHealthEvidence } from "@/obs/durableHealthProjection";
import type { RiskState } from "@fdbtrade/contracts";
import type { DatabaseSync } from "node:sqlite";

export function durableRiskState(database?: DatabaseSync): RiskState | null {
  try {
    const authority = database ?? getDatabase();
    const row = authority.prepare(`
      SELECT state FROM risk_state_events ORDER BY sequence_no DESC LIMIT 1
    `).get() as { state?: unknown } | undefined;
    const state = row?.state;
    return state === "green" || state === "yellow" || state === "orange" ||
      state === "red" || state === "kill" ? state : null;
  } catch {
    return null;
  }
}

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

/** Default read-only factory over durable operational evidence. */
export const defaultCheckFactory: CheckFactory = async () => {
  const atUtc = utcNowIso();
  const databaseHealth = await checkDatabaseHealth();
  if (databaseHealth.status !== "ok") {
    const unavailable: HealthCheck[] = (["feed", "queue", "api", "cache", "risk"] as const).map((component) => ({
      component,
      status: "unknown",
      observedAtUtc: atUtc,
      reason: "check_missing",
      metrics: { authority: "unavailable" },
    }));
    unavailable.push({
      component: "db",
      status: "down",
      observedAtUtc: atUtc,
      reason: "db_unreachable",
      metrics: { latencyMs: databaseHealth.latencyMs },
    });
    return unavailable;
  }
  try {
    return durableHealthEvidence(getDatabase(), {
      artifactRoot: MARKET_DATA_ARTIFACT_ROOT,
      observedAtUtc: atUtc,
    }).checks;
  } catch {
    return (["feed", "queue", "api", "db", "cache", "risk"] as const).map((component) => ({
      component,
      status: "unknown" as const,
      observedAtUtc: atUtc,
      reason: "check_missing" as const,
      metrics: { authority: "durable-health-projection" },
    }));
  }
};

/** Compute the current health snapshot (default runtime checks). */
export async function currentHealthSnapshot(
  factory: CheckFactory = defaultCheckFactory,
  riskStateReader: () => RiskState | null = durableRiskState,
): Promise<HealthSnapshot> {
  const checks = await factory();
  const riskState = riskStateReader() ?? "kill";
  return computeHealthSnapshot({
    asOfUtc: utcNowIso(),
    riskState,
    checks,
    budgets: HEALTH_BUDGETS,
  });
}
