/**
 * Provider/system health contract tests (P13-04).
 *
 * Covers: fail-safe mapping totality + explicit behaviors, check schema
 * (ok/reason pairing), staleness budgets (warn/max, no green-by-default,
 * future check refusal, missing budget refusal), snapshot computation
 * (healthy, degraded queue/api/cache, fail-safe feed/db/risk, risk-state
 * contributions, empty checks = fail_safe, reason aggregation, deterministic
 * ordering), and malformed input refusals.
 */
import { describe, expect, it } from "vitest";

import {
  computeHealthSnapshot,
  failSafeActionFor,
  healthCheckSchema,
  HEALTH_COMPONENTS,
  HEALTH_FAIL_SAFE_ACTIONS,
  HEALTH_REASON_CODES,
  stalenessFor,
  type HealthCheck,
  type HealthComponent,
} from "../obs/health";

const T0 = "2026-09-11T13:00:00.000Z";
const MINUTE = 60_000;

const BUDGETS: Record<HealthComponent, { warnAgeMs: number; maxAgeMs: number }> = {
  feed: { warnAgeMs: 5 * MINUTE, maxAgeMs: 30 * MINUTE },
  queue: { warnAgeMs: 5 * MINUTE, maxAgeMs: 30 * MINUTE },
  api: { warnAgeMs: 5 * MINUTE, maxAgeMs: 30 * MINUTE },
  db: { warnAgeMs: 10 * MINUTE, maxAgeMs: 60 * MINUTE },
  cache: { warnAgeMs: 5 * MINUTE, maxAgeMs: 30 * MINUTE },
  risk: { warnAgeMs: 5 * MINUTE, maxAgeMs: 30 * MINUTE },
};

function check(
  component: HealthComponent,
  overrides: Partial<HealthCheck> = {},
): HealthCheck {
  return {
    component,
    status: "ok",
    observedAtUtc: T0,
    reason: null,
    metrics: { latencyMs: 12 },
    ...overrides,
  };
}

function okAll(): HealthCheck[] {
  return [
    check("feed"),
    check("queue"),
    check("api"),
    check("db"),
    check("cache"),
    check("risk"),
  ];
}

describe("fail-safe mapping", () => {
  it("is total: every state has an explicit action", () => {
    for (const state of ["healthy", "degraded", "fail_safe"] as const) {
      const action = failSafeActionFor(state);
      expect(typeof action.description).toBe("string");
      expect(action.description.length).toBeGreaterThan(10);
    }
    expect(HEALTH_FAIL_SAFE_ACTIONS.healthy.denyNewEntries).toBe(false);
    expect(HEALTH_FAIL_SAFE_ACTIONS.degraded.reduceRisk).toBe(true);
    expect(HEALTH_FAIL_SAFE_ACTIONS.fail_safe.denyNewEntries).toBe(true);
  });

  it("rejects an unknown state (fail closed)", () => {
    expect(() => failSafeActionFor("great" as never)).toThrow();
  });
});

describe("health check schema", () => {
  it("ok checks carry reason null; non-ok carry a reason code", () => {
    expect(() => healthCheckSchema.parse(check("feed"))).not.toThrow();
    expect(() =>
      healthCheckSchema.parse(check("feed", { status: "degraded" })),
    ).toThrow(/reason/);
    expect(() =>
      healthCheckSchema.parse(check("feed", { status: "degraded", reason: "feed_stale" })),
    ).not.toThrow();
    expect(() =>
      healthCheckSchema.parse(check("feed", { reason: "feed_stale" })),
    ).toThrow(/reason/);
  });

  it("rejects malformed components, times and metrics", () => {
    expect(() => healthCheckSchema.parse(check("quantum" as never))).toThrow();
    expect(() =>
      healthCheckSchema.parse(check("feed", { observedAtUtc: "2026-09-11T13:00:00Z" })),
    ).toThrow();
    expect(() => healthCheckSchema.parse(check("feed", { metrics: { api_key: "x" } }))).toThrow();
    expect(() =>
      healthCheckSchema.parse(check("feed", { status: "maybe" as never })),
    ).toThrow();
  });
});

describe("staleness", () => {
  it("fresh ok stays ok; warn-age ok degrades; max-age is unknown", () => {
    expect(stalenessFor(check("feed"), T0, BUDGETS)).toEqual({
      status: "ok",
      reason: null,
      ageMs: 0,
    });
    const warn = stalenessFor(
      check("feed", { observedAtUtc: "2026-09-11T12:54:00.000Z" }),
      T0,
      BUDGETS,
    );

    expect(warn.status).toBe("degraded");
    expect(warn.reason).toBe("check_stale");
    const stale = stalenessFor(
      check("feed", { observedAtUtc: "2026-09-11T12:00:00.000Z" }),
      T0,
      BUDGETS,
    );
    expect(stale.status).toBe("unknown");
    expect(stale.reason).toBe("check_stale");
  });

  it("non-ok statuses keep their own severity (staleness does not mask)", () => {
    const result = stalenessFor(
      check("feed", {
        observedAtUtc: "2026-09-11T12:00:00.000Z",
        status: "degraded",
        reason: "feed_no_data",
      }),
      T0,
      BUDGETS,
    );
    expect(result.status).toBe("unknown");
    expect(result.reason).toBe("check_stale");
  });

  it("refuses future checks and missing budgets (fail closed)", () => {
    expect(() =>
      stalenessFor(check("feed", { observedAtUtc: "2026-09-11T13:00:00.001Z" }), T0, BUDGETS),
    ).toThrow(/after asOfUtc/);
    const partial = { feed: BUDGETS.feed } as typeof BUDGETS;
    expect(() => stalenessFor(check("queue"), T0, partial)).toThrow(/no freshness budget/);
  });
});

describe("snapshot computation", () => {
  it("all-ok checks with green risk -> healthy, entries allowed", () => {
    const snapshot = computeHealthSnapshot({
      asOfUtc: T0,
      riskState: "green",
      checks: okAll(),
      budgets: BUDGETS,
    });
    expect(snapshot.state).toBe("healthy");
    expect(snapshot.failSafe.denyNewEntries).toBe(false);
    expect(snapshot.reasons).toEqual([]);
    expect(snapshot.checks.map((c) => c.component)).toEqual([...HEALTH_COMPONENTS]);
  });

  it("degraded queue/api/cache -> degraded (reduced risk, not fail-safe)", () => {
    const snapshot = computeHealthSnapshot({
      asOfUtc: T0,
      riskState: "green",
      checks: [
        check("feed"),
        check("queue", { status: "degraded", reason: "queue_backlog" }),
        check("api"),
        check("db"),
        check("cache"),
        check("risk"),
      ],
      budgets: BUDGETS,
    });
    expect(snapshot.state).toBe("degraded");
    expect(snapshot.failSafe.denyNewEntries).toBe(false);
    expect(snapshot.failSafe.reduceRisk).toBe(true);
    expect(snapshot.reasons).toEqual(["queue_backlog"]);
  });

  it("down feed or db or risk -> fail_safe (deny new entries)", () => {
    const reasons = {
      feed: "feed_stale",
      db: "db_unreachable",
      risk: "risk_state_red",
    } as const;
    for (const component of ["feed", "db", "risk"] as const) {
      const checks = okAll().map((c) =>
        c.component === component
          ? { ...c, status: "down" as const, reason: reasons[component] }
          : c,
      );
      const snapshot = computeHealthSnapshot({
        asOfUtc: T0,
        riskState: "green",
        checks,
        budgets: BUDGETS,
      });
      expect(snapshot.state).toBe("fail_safe");
      expect(snapshot.failSafe.denyNewEntries).toBe(true);
    }
  });

  it("stale ok checks are NOT healthy (no green-by-default)", () => {
    // All checks observed 30+ minutes before asOf -> beyond every maxAge
    // budget -> unknown -> feed/db/risk drive fail_safe; nothing stays ok.
    const snapshot = computeHealthSnapshot({
      asOfUtc: "2026-09-11T14:00:00.000Z",
      riskState: "green",
      checks: okAll().map((c) => ({ ...c, observedAtUtc: "2026-09-11T13:20:00.000Z" })),
      budgets: BUDGETS,
    });
    expect(snapshot.state).not.toBe("healthy");
    expect(snapshot.reasons).toContain("check_stale");
    expect(snapshot.state).toBe("fail_safe");
  });

  it("risk state orange/red/kill map to degraded/fail_safe/fail_safe", () => {
    const orange = computeHealthSnapshot({
      asOfUtc: T0,
      riskState: "orange",
      checks: okAll(),
      budgets: BUDGETS,
    });
    expect(orange.state).toBe("degraded");
    expect(orange.reasons).toContain("risk_state_orange");
    const red = computeHealthSnapshot({
      asOfUtc: T0,
      riskState: "red",
      checks: okAll(),
      budgets: BUDGETS,
    });
    expect(red.state).toBe("fail_safe");
    expect(red.reasons).toContain("risk_state_red");
    const kill = computeHealthSnapshot({
      asOfUtc: T0,
      riskState: "kill",
      checks: okAll(),
      budgets: BUDGETS,
    });
    expect(kill.state).toBe("fail_safe");
    expect(kill.reasons).toContain("risk_kill_engaged");
  });

  it("empty check set is fail_safe via check_missing (absence is never healthy)", () => {
    const snapshot = computeHealthSnapshot({
      asOfUtc: T0,
      riskState: "green",
      checks: [],
      budgets: BUDGETS,
    });
    expect(snapshot.state).toBe("fail_safe");
    expect(snapshot.reasons).toEqual(["check_missing"]);
  });

  it("deterministic: shuffled check order produces an identical snapshot", () => {
    const a = computeHealthSnapshot({
      asOfUtc: T0,
      riskState: "yellow",
      checks: okAll(),
      budgets: BUDGETS,
    });
    const b = computeHealthSnapshot({
      asOfUtc: T0,
      riskState: "yellow",
      checks: [...okAll()].reverse(),
      budgets: BUDGETS,
    });
    expect(b).toEqual(a);
  });

  it("rejects malformed asOf/risk state (fail closed)", () => {
    expect(() =>
      computeHealthSnapshot({
        asOfUtc: "not-a-time",
        riskState: "green",
        checks: okAll(),
        budgets: BUDGETS,
      }),
    ).toThrow();
    expect(() =>
      computeHealthSnapshot({
        asOfUtc: T0,
        riskState: "purple" as never,
        checks: okAll(),
        budgets: BUDGETS,
      }),
    ).toThrow();
  });

  it("reason vocabulary stays frozen", () => {
    expect(HEALTH_REASON_CODES).toContain("feed_stale");
    expect(HEALTH_REASON_CODES).toContain("risk_kill_engaged");
    expect(HEALTH_REASON_CODES).toContain("check_missing");
  });
});


