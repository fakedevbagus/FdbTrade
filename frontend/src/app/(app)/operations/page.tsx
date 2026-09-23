import type { Metadata } from "next";
import { cookies } from "next/headers";

import { EmptyState, ErrorState } from "@/components/ui";
import { fetchOperationalOverview } from "@/lib/operations";

export const metadata: Metadata = { title: "Operations" };
export const dynamic = "force-dynamic";

function counts(value: Record<string, number>): string {
  const entries = Object.entries(value);
  return entries.length === 0 ? "none" : entries.map(([key, count]) => `${key}=${count}`).join(", ");
}

export default async function OperationsPage(): Promise<React.JSX.Element> {
  const store = await cookies();
  const session = store.get("fdb_session");
  const result = await fetchOperationalOverview(
    session ? `fdb_session=${session.value}` : undefined,
  );
  if (!result.ok) {
    return <div className="fdb-page"><h1>Operations</h1><ErrorState title="Operational authority unavailable" message={result.error} /></div>;
  }
  const view = result.data;
  return (
    <div className="fdb-page">
      <h1>Operational authority</h1>
      <p className="fdb-page__lead">
        Read-only projection from SQLite. The UI is not authority and cannot bypass the durable
        risk decision or paper boundary.
      </p>
      <div className="fdb-grid">
        <section className="fdb-card"><h2>Scope</h2><p>{view.scope.instruments.join(", ")}</p><p>Timeframes: {view.scope.timeframes.join(", ")}</p></section>
        <section className="fdb-card"><h2>Risk latch</h2><p>{view.risk.initialized ? `${view.risk.state} · event #${view.risk.sequenceNo}` : "UNINITIALIZED — fail closed"}</p><p>{view.risk.effectiveAtUtc ?? "No durable risk-state event"}</p></section>
        <section className="fdb-card"><h2>Safety boundary</h2><p>Mode: {view.safety.executionMode}</p><p>Live execution: OFF · provider transport: OFF</p><p>Promotion authority: none</p></section>
        <section className="fdb-card"><h2>Market and signals</h2><p>Datasets: {view.counts.datasets}</p><p>Candidates: {view.counts.signalCandidates}</p><p>Runs: {counts(view.counts.signalRuns)}</p></section>
        <section className="fdb-card"><h2>Research</h2><p>Runs: {counts(view.counts.researchRuns)}</p><p>Historical evidence only; never signal confidence.</p></section>
        <section className="fdb-card"><h2>Risk and paper</h2><p>Runs: {counts(view.counts.riskPaperRuns)}</p><p>Outcomes: {view.counts.paperOutcomes}</p><p>Reconciliation failures: {view.counts.reconciliationFailures}</p></section>
      </div>
      <section className="fdb-card" aria-labelledby="op-signals">
        <h2 id="op-signals">Recent authoritative candidates</h2>
        {view.recentSignals.length === 0 ? <EmptyState title="No signal candidates" description="No durable R0.7 candidate exists yet." /> : (
          <table className="fdb-table"><thead><tr><th>Instrument</th><th>TF</th><th>Direction</th><th>Lifecycle</th><th>Event UTC</th></tr></thead><tbody>{view.recentSignals.map((signal) => <tr key={signal.signalId}><td>{signal.instrument}</td><td>{signal.timeframe}</td><td>{signal.direction}</td><td>{signal.lifecycleState ?? "unknown"}</td><td>{signal.eventTimeUtc}</td></tr>)}</tbody></table>
        )}
      </section>
      <section className="fdb-card" aria-labelledby="op-paper">
        <h2 id="op-paper">Recent risk/paper lineage</h2>
        {view.recentPaperRuns.length === 0 ? <EmptyState title="No paper runs" description="No durable R0.9 risk/paper run exists yet." /> : (
          <table className="fdb-table"><thead><tr><th>Run</th><th>Status</th><th>Risk</th><th>Outcome</th><th>Updated UTC</th></tr></thead><tbody>{view.recentPaperRuns.map((run) => <tr key={run.runId}><td>{run.runId}</td><td>{run.status}</td><td>{run.riskOutcome ?? "pending"}</td><td>{run.outcomeId ?? "none"}</td><td>{run.updatedAtUtc}</td></tr>)}</tbody></table>
        )}
      </section>
      <section className="fdb-card" aria-labelledby="op-events">
        <h2 id="op-events">Backup, restore, and deployment drills</h2>
        {view.operationalEvents.length === 0 ? <EmptyState title="No operational drill evidence" description="Run the hermetic deployment drill before relying on recovery readiness." /> : (
          <table className="fdb-table"><thead><tr><th>Sequence</th><th>Type</th><th>Status</th><th>UTC</th><th>Digest</th></tr></thead><tbody>{view.operationalEvents.map((event) => <tr key={event.eventId}><td>{event.sequenceNo}</td><td>{event.eventType}</td><td>{event.status}</td><td>{event.occurredAtUtc}</td><td><small>{event.eventDigest.slice(0, 16)}…</small></td></tr>)}</tbody></table>
        )}
      </section>
    </div>
  );
}
