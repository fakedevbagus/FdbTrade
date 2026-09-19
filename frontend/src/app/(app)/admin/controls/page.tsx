/**
 * Operational controls page (P13-05).
 *
 * Feature flags (live execution LOCKED OFF — P17 gate), kill-switch UI,
 * publish/rollback state and incident notes. Every privileged action posts
 * to the backend, which authenticates, authorizes (RBAC) and audits; the
 * UI is a surface, never the authority.
 */
import type { Metadata } from "next";
import type { JSX } from "react";
import { cookies } from "next/headers";

import { KillSwitchForm } from "@/components/admin/KillSwitchForm";
import { EmptyState, ErrorState } from "@/components/ui";
import { fetchControls } from "@/lib/controls";

export const metadata: Metadata = {
  title: "Operational controls",
};

export const dynamic = "force-dynamic";

const FLAG_BADGES: Record<string, string> = {
  signal_alerts: "fdb-badge--ok",
  paper_execution: "fdb-badge--warn",
  ensemble_dashboard: "fdb-badge--ok",
  research_lab: "fdb-badge--ok",
  live_execution: "fdb-badge--danger",
};

const RISK_BADGES: Record<string, string> = {
  green: "fdb-badge--ok",
  yellow: "fdb-badge--warn",
  orange: "fdb-badge--warn",
  red: "fdb-badge--danger",
  kill: "fdb-badge--danger",
};

const SEVERITY_BADGES: Record<string, string> = {
  low: "fdb-badge--ok",
  medium: "fdb-badge--warn",
  high: "fdb-badge--danger",
  critical: "fdb-badge--danger",
};

export default async function ControlsPage(): Promise<JSX.Element> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("fdb_session");
  const cookie = sessionCookie ? `fdb_session=${sessionCookie.value}` : undefined;

  const result = await fetchControls(cookie);
  if (!result.ok) {
    return (
      <div className="fdb-page">
        <h1>Operational controls</h1>
        <ErrorState title="Controls unavailable" message={result.error} />
      </div>
    );
  }

  const { flags, riskState, riskStateChangedAtUtc, publish, incidents } = result.data;

  return (
    <div className="fdb-page">
      <h1>Operational controls</h1>
      <p className="fdb-page__lead">
        Risk state:{" "}
        <span className={`fdb-badge ${RISK_BADGES[riskState] ?? ""}`}>{riskState}</span>{" "}
        (since {riskStateChangedAtUtc} UTC). Privileged actions are
        authenticated, authorized (RBAC) and audited. Live execution is locked
        OFF until the P17 live gate.
      </p>
      <div className="fdb-grid">
        <section className="fdb-card" aria-labelledby="ctl-flags">
          <h2 id="ctl-flags">Feature flags</h2>
          <table className="fdb-table">
            <thead>
              <tr>
                <th scope="col">Flag</th>
                <th scope="col">State</th>
                <th scope="col">Updated (UTC)</th>
                <th scope="col">By</th>
              </tr>
            </thead>
            <tbody>
              {flags.map((flag) => (
                <tr key={flag.key}>
                  <td>{flag.key}</td>
                  <td>
                    <span className={`fdb-badge ${FLAG_BADGES[flag.key] ?? ""}`}>
                      {flag.enabled ? "on" : "off"}
                    </span>
                    {flag.key === "live_execution" ? " (locked — P17 gate)" : ""}
                  </td>
                  <td>{flag.updatedAtUtc}</td>
                  <td>{flag.updatedBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="fdb-card" aria-labelledby="ctl-kill">
          <h2 id="ctl-kill">Kill switch</h2>
          <KillSwitchForm riskState={riskState} cookie={cookie} />
        </section>
        <section className="fdb-card" aria-labelledby="ctl-publish">
          <h2 id="ctl-publish">Publish / rollback</h2>
          {Object.keys(publish.current).length === 0 ? (
            <EmptyState
              title="No live artifacts"
              description="Published strategy versions appear here with their rollback pointers. Publishing requires registry entries and champion evidence."
            />
          ) : (
            <table className="fdb-table">
              <thead>
                <tr>
                  <th scope="col">Family</th>
                  <th scope="col">Live artifact</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(publish.current).map(([family, artifactId]) => (
                  <tr key={family}>
                    <td>{family}</td>
                    <td>{artifactId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p>
            Publish history: {publish.history.length} record(s) (rolled-back
            records stay visible).
          </p>
        </section>
        <section className="fdb-card" aria-labelledby="ctl-incidents">
          <h2 id="ctl-incidents">Incident notes ({incidents.length})</h2>
          {incidents.length === 0 ? (
            <EmptyState
              title="No incident notes"
              description="Operators can record incidents with severity and resolution; the history is immutable."
            />
          ) : (
            <table className="fdb-table">
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col">Severity</th>
                  <th scope="col">Status</th>
                  <th scope="col">Created (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {incidents.map((incident) => (
                  <tr key={incident.incidentId}>
                    <td>{incident.title}</td>
                    <td>
                      <span
                        className={`fdb-badge ${SEVERITY_BADGES[incident.severity] ?? ""}`}
                      >
                        {incident.severity}
                      </span>
                    </td>
                    <td>{incident.status}</td>
                    <td>{incident.createdAtUtc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
