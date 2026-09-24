import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import type { JSX } from "react";

import { SignalEvaluationForm } from "@/components/signals/SignalEvaluationForm";
import { EmptyState, ErrorState } from "@/components/ui";
import {
  fetchSignalEvaluation,
  fetchSignalWorkbench,
  type SignalWorkbenchRun,
} from "@/lib/signal-workbench";

export const metadata: Metadata = { title: "Authoritative signal workbench" };
export const dynamic = "force-dynamic";

function outcomeClass(outcome: SignalWorkbenchRun["outcome"]): string {
  if (outcome === "candidate") return "fdb-badge fdb-badge--ok";
  if (outcome === "failed" || outcome === "blocked") {
    return "fdb-badge fdb-badge--danger";
  }
  return "fdb-badge fdb-badge--warn";
}

function Detail({ run }: { run: SignalWorkbenchRun }): JSX.Element {
  const signal = run.candidate?.signal ?? null;
  return (
    <section className="fdb-card" aria-labelledby="signal-detail-heading">
      <h2 id="signal-detail-heading">Evaluation detail</h2>
      <p>
        <span className={outcomeClass(run.outcome)}>{run.outcome}</span>{" "}
        {run.runId} · attempts {run.attempts}
      </p>
      <table className="fdb-table">
        <tbody>
          <tr><th scope="row">Dataset</th><td>{run.dataset.datasetId}</td></tr>
          <tr><th scope="row">Artifact SHA-256</th><td>{run.dataset.artifactDigest}</td></tr>
          <tr><th scope="row">Scope</th><td>{run.dataset.instrument} · {run.dataset.timeframe} · {run.dataset.sourceMode}</td></tr>
          <tr><th scope="row">Dataset quality</th><td>{run.dataset.qualityState} · stored freshness {run.dataset.freshnessState}</td></tr>
          <tr><th scope="row">Assessment UTC</th><td>{run.assessedAtUtc}</td></tr>
          <tr><th scope="row">Rule</th><td>{run.rule.ruleId} · logic {run.rule.logicVersion} · config {run.rule.configVersion}</td></tr>
          <tr><th scope="row">Rule config digest</th><td>{run.rule.configDigest}</td></tr>
          <tr><th scope="row">Evidence reasons</th><td>{run.evidence?.reasons.join(", ") || "—"}</td></tr>
          <tr><th scope="row">Failure reason</th><td>{run.failureReason ?? "—"}</td></tr>
        </tbody>
      </table>
      {signal ? (
        <>
          <h3>Authoritative candidate</h3>
          <table className="fdb-table">
            <tbody>
              <tr><th scope="row">Signal</th><td>{signal.signalId}</td></tr>
              <tr><th scope="row">Direction</th><td>{signal.direction}</td></tr>
              <tr><th scope="row">Reference / stop / target</th><td>{signal.referencePrice} / {signal.stopLoss} / {signal.takeProfit ?? "—"}</td></tr>
              <tr><th scope="row">Event / expiry UTC</th><td>{signal.eventTimeUtc}<br />{signal.expiresAtUtc}</td></tr>
              <tr><th scope="row">Lifecycle</th><td>{run.candidate?.lifecycle.map((event) => `${event.state} @ ${event.effectiveAtUtc}`).join("; ")}</td></tr>
              <tr><th scope="row">Snapshot hash</th><td>{signal.snapshotHash}</td></tr>
            </tbody>
          </table>
          <p className="fdb-page__lead">
            The deterministic confidence field is not a win probability,
            research result, live evidence, or permission to execute.
          </p>
        </>
      ) : (
        <p className="fdb-page__lead">
          No candidate exists for this outcome. WAIT, BLOCKED, and FAILED are
          durable evidence states, not missing green results.
        </p>
      )}
    </section>
  );
}

export default async function SignalWorkbenchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<JSX.Element> {
  const params = await searchParams;
  const selectedRunId = typeof params.runId === "string" ? params.runId : null;
  const store = await cookies();
  const session = store.get("fdb_session");
  const cookie = session ? `fdb_session=${session.value}` : undefined;
  const result = await fetchSignalWorkbench(cookie);

  if (!result.ok) {
    return (
      <div className="fdb-page">
        <h1>Authoritative signal workbench</h1>
        <ErrorState title="Signal workbench unavailable" message={result.error} />
      </div>
    );
  }

  const detail = selectedRunId
    ? await fetchSignalEvaluation(selectedRunId, cookie)
    : null;
  const view = result.data;

  return (
    <div className="fdb-page">
      <h1>Authoritative signal workbench</h1>
      <p className="fdb-page__lead">
        Select immutable R0.6 data and explicitly invoke the existing R0.12
        endpoint. SQLite and verified artifacts remain authority; this UI is a
        read projection. The legacy scanner is not used here.
      </p>

      <div className="fdb-grid">
        <section className="fdb-card" aria-labelledby="signal-evaluate-heading">
          <h2 id="signal-evaluate-heading">New evaluation</h2>
          <SignalEvaluationForm datasets={view.datasets} />
          {view.datasets.length === 0 ? (
            <EmptyState
              title="No registered datasets"
              description="Register an R0.6 historical dataset before evaluating. No fixture fallback is invented."
            />
          ) : null}
        </section>

        <section className="fdb-card" aria-labelledby="signal-boundaries-heading">
          <h2 id="signal-boundaries-heading">Locked boundaries</h2>
          <ul className="fdb-list">
            <li>Frozen authoritative-momentum-baseline rule</li>
            <li>No R0.8 research or R0.9 risk/paper invocation</li>
            <li>No scheduler, provider network, model promotion, demo or live execution</li>
            <li>Duplicate requests reopen one durable evaluation</li>
          </ul>
        </section>
      </div>

      <section className="fdb-card" aria-labelledby="signal-runs-heading">
        <h2 id="signal-runs-heading">Durable evaluations ({view.evaluations.total})</h2>
        {view.evaluations.runs.length === 0 ? (
          <EmptyState
            title="No signal evaluations"
            description="Choose a registered dataset above. Empty state is authoritative; the legacy scanner is not a fallback."
          />
        ) : (
          <table className="fdb-table">
            <thead>
              <tr>
                <th scope="col">Outcome</th>
                <th scope="col">Dataset</th>
                <th scope="col">Assessment UTC</th>
                <th scope="col">Rule lineage</th>
                <th scope="col">Candidate</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {view.evaluations.runs.map((run) => (
                <tr key={run.runId}>
                  <td><span className={outcomeClass(run.outcome)}>{run.outcome}</span></td>
                  <td>{run.dataset.instrument} · {run.dataset.timeframe}<br /><small>{run.dataset.datasetId}</small></td>
                  <td>{run.assessedAtUtc}</td>
                  <td>{run.rule.logicVersion} / {run.rule.configVersion}</td>
                  <td>{run.candidate?.signal.signalId ?? "—"}</td>
                  <td><Link href={`/signals/workbench?runId=${encodeURIComponent(run.runId)}`}>Inspect</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {view.evaluations.total > view.evaluations.limit ? (
          <p className="fdb-page__lead">Showing the newest {view.evaluations.limit} evaluations.</p>
        ) : null}
      </section>

      {detail?.ok ? <Detail run={detail.data} /> : null}
      {detail && !detail.ok ? (
        <ErrorState title="Evaluation detail unavailable" message={detail.error} />
      ) : null}
    </div>
  );
}
