/**
 * System health page (P13-04).
 *
 * Provider/system health dashboard: per-component checks (feed freshness,
 * queue backlog, API failures, DB, cache, latency metrics), the current
 * risk state and the EXPLICIT fail-safe behavior for the computed state.
 * Stale or missing checks are shown degraded/down — never green-by-default.
 */
import type { Metadata } from "next";
import type { JSX } from "react";
import { cookies } from "next/headers";

import { ErrorState } from "@/components/ui";
import { fetchHealthSnapshot } from "@/lib/health";

export const metadata: Metadata = {
  title: "System health",
};

export const dynamic = "force-dynamic";

const STATE_BADGES: Record<string, string> = {
  healthy: "fdb-badge--ok",
  degraded: "fdb-badge--warn",
  fail_safe: "fdb-badge--danger",
};

const CHECK_BADGES: Record<string, string> = {
  ok: "fdb-badge--ok",
  degraded: "fdb-badge--warn",
  down: "fdb-badge--danger",
  unknown: "fdb-badge--danger",
};

const RISK_BADGES: Record<string, string> = {
  green: "fdb-badge--ok",
  yellow: "fdb-badge--warn",
  orange: "fdb-badge--warn",
  red: "fdb-badge--danger",
  kill: "fdb-badge--danger",
};

export default async function HealthPage(): Promise<JSX.Element> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("fdb_session");
  const cookie = sessionCookie ? `fdb_session=${sessionCookie.value}` : undefined;

  const result = await fetchHealthSnapshot(cookie);
  if (!result.ok) {
    return (
      <div className="fdb-page">
        <h1>System health</h1>
        <ErrorState title="Health unavailable" message={result.error} />
      </div>
    );
  }

  const snapshot = result.data;

  return (
    <div className="fdb-page">
      <h1>System health</h1>
      <p className="fdb-page__lead">
        As of {snapshot.asOfUtc} (UTC). Risk state:{" "}
        <span className={`fdb-badge ${RISK_BADGES[snapshot.riskState] ?? ""}`}>
          {snapshot.riskState}
        </span>
      </p>
      <section className="fdb-card" aria-labelledby="hl-state">
        <h2 id="hl-state">
          Overall state:{" "}
          <span className={`fdb-badge ${STATE_BADGES[snapshot.state] ?? ""}`}>
            {snapshot.state}
          </span>
        </h2>
        <p>
          <strong>Fail-safe behavior:</strong> {snapshot.failSafe.description}
        </p>
        <ul className="fdb-list">
          <li>
            New entries: {snapshot.failSafe.denyNewEntries ? "DENIED (fail closed)" : "allowed"}
          </li>
          <li>Risk budget: {snapshot.failSafe.reduceRisk ? "REDUCED" : "full"}</li>
          <li>
            Reasons:{" "}
            {snapshot.reasons.length > 0 ? snapshot.reasons.join(", ") : "none — all checks ok"}
          </li>
        </ul>
      </section>
      <section className="fdb-card" aria-labelledby="hl-checks">
        <h2 id="hl-checks">Components ({snapshot.checks.length})</h2>
        <table className="fdb-table">
          <thead>
            <tr>
              <th scope="col">Component</th>
              <th scope="col">Effective status</th>
              <th scope="col">Observed (UTC)</th>
              <th scope="col">Age</th>
              <th scope="col">Reason</th>
              <th scope="col">Metrics</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.checks.map((check) => (
              <tr key={check.component}>
                <td>{check.component}</td>
                <td>
                  <span className={`fdb-badge ${CHECK_BADGES[check.effectiveStatus] ?? ""}`}>
                    {check.effectiveStatus}
                  </span>
                </td>
                <td>{check.observedAtUtc}</td>
                <td>{Math.round(check.ageMs / 1000)}s</td>
                <td>{check.reason ?? "—"}</td>
                <td>
                  <small>
                    {Object.entries(check.metrics)
                      .map(([key, value]) => `${key}=${String(value)}`)
                      .join(", ") || "—"}
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="fdb-page__lead">
          Stale checks degrade automatically; feed/db/risk failures fail
          closed for new entries. Health is never green without fresh
          evidence.
        </p>
      </section>
    </div>
  );
}
