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
import { ErrorState } from "@/components/ui";
import { fetchControls } from "@/lib/controls";

export const metadata: Metadata = {
  title: "Operational controls",
};

export const dynamic = "force-dynamic";

const RISK_BADGES: Record<string, string> = {
  green: "fdb-badge--ok",
  yellow: "fdb-badge--warn",
  orange: "fdb-badge--warn",
  red: "fdb-badge--danger",
  kill: "fdb-badge--danger",
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

  const { riskState, riskStateSequenceNo, riskStateChangedAtUtc, safety } = result.data;

  return (
    <div className="fdb-page">
      <h1>Operational controls</h1>
      <p className="fdb-page__lead">
        Risk state:{" "}
        <span className={`fdb-badge ${RISK_BADGES[riskState] ?? ""}`}>{riskState}</span>{" "}
        (durable event #{riskStateSequenceNo}, since {riskStateChangedAtUtc} UTC).
        This UI writes only through the R0.9 SQLite risk-state authority.
      </p>
      <div className="fdb-grid">
        <section className="fdb-card" aria-labelledby="ctl-kill">
          <h2 id="ctl-kill">Kill switch</h2>
          <KillSwitchForm riskState={riskState} cookie={cookie} />
        </section>
        <section className="fdb-card" aria-labelledby="ctl-boundary">
          <h2 id="ctl-boundary">Execution boundary</h2>
          <ul className="fdb-list">
            <li>Mode: {safety.executionMode}</li>
            <li>Live execution: {safety.liveExecutionEnabled ? "ON" : "OFF"}</li>
            <li>Provider order transport: {safety.providerOrderTransportEnabled ? "ON" : "OFF"}</li>
          </ul>
          <p>The UI cannot submit a paper or live order and cannot promote a model.</p>
        </section>
      </div>
    </div>
  );
}
