import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import type { JSX } from "react";

import { PaperConfirmationForm } from "@/components/paper/PaperConfirmationForm";
import { EmptyState, ErrorState } from "@/components/ui";
import { fetchPaperRun, fetchPaperWorkbench, type PaperRun } from "@/lib/paper-workbench";

export const metadata: Metadata = { title: "Paper and outcome workbench" };
export const dynamic = "force-dynamic";

function statusClass(state: PaperRun["operatorState"]): string {
  if (state === "succeeded") return "fdb-badge fdb-badge--ok";
  if (["blocked", "rejected", "failed"].includes(state)) return "fdb-badge fdb-badge--danger";
  return "fdb-badge fdb-badge--warn";
}

function Detail({ run }: { run: PaperRun }): JSX.Element {
  return <section className="fdb-card" aria-labelledby="paper-detail-heading">
    <h2 id="paper-detail-heading">Durable run detail</h2>
    <p><span className={statusClass(run.operatorState)}>{run.operatorState}</span>{" "}<span className="fdb-mono-wrap">{run.runId}</span></p>
    <h3>Risk verdict</h3>
    {run.riskDecision ? <table className="fdb-table"><tbody>
      <tr><th scope="row">Verdict / state</th><td>{run.riskDecision.outcome} / {run.riskDecision.riskState}</td></tr>
      <tr><th scope="row">Reasons</th><td>{run.riskDecision.reasons.join(", ") || "approved with no rejection reasons"}</td></tr>
      <tr><th scope="row">Requested / authorized units</th><td>{run.riskDecision.requestedQuantityUnits} / {run.riskDecision.sizedQuantityUnits}</td></tr>
      <tr><th scope="row">Planned account risk</th><td>{run.riskDecision.riskAmountAccount} ({run.riskDecision.riskFractionUsed})</td></tr>
      <tr><th scope="row">Decision identity</th><td className="fdb-mono-wrap">{run.riskDecision.decisionId} · {run.riskDecision.requestDigest}</td></tr>
    </tbody></table> : <p className="fdb-page__lead">No durable risk verdict exists for this lifecycle state. Nothing is inferred.</p>}

    <h3>Paper order and fills</h3>
    {run.order ? <table className="fdb-table"><tbody>
      <tr><th scope="row">Order</th><td className="fdb-mono-wrap">{run.order.orderId}</td></tr>
      <tr><th scope="row">Instrument / direction</th><td>{run.order.instrument} · {run.order.timeframe} · {run.order.direction}</td></tr>
      <tr><th scope="row">Type / units</th><td>{run.order.orderType} / {run.order.quantityUnits}</td></tr>
      <tr><th scope="row">Reference / stop / target</th><td>{run.order.referencePrice} / {run.order.stopLoss} / {run.order.takeProfit ?? "—"}</td></tr>
    </tbody></table> : <p className="fdb-page__lead">No paper order exists for this lifecycle state.</p>}
    {run.fills.length === 0 ? <p className="fdb-page__lead">No fills. Rejected risk must remain fill-free.</p> : <table className="fdb-table"><thead><tr><th>Side</th><th>UTC</th><th>Price</th><th>Units</th><th>Costs (spread/slippage/commission)</th></tr></thead><tbody>{run.fills.map((fill) => <tr key={fill.fillId}><td>{fill.side}</td><td>{fill.atUtc}</td><td>{fill.price}</td><td>{fill.quantityUnits}</td><td>{fill.costs.spreadPips} / {fill.costs.slippagePips} / {fill.costs.commissionPips}</td></tr>)}</tbody></table>}

    <h3>Position ledger and reconciliation</h3>
    {run.positionEvents.length === 0 ? <p className="fdb-page__lead">No authoritative position events are available.</p> : <ul className="fdb-list">{run.positionEvents.map((position, index) => <li key={index}><code>{JSON.stringify(position)}</code></li>)}</ul>}
    <p>Reconciliation: <strong>{run.reconciliation === null ? "unavailable" : run.reconciliation.ok === true ? "verified" : "failed closed"}</strong></p>

    <h3>Paper-only outcome</h3>
    {run.outcome ? <pre className="fdb-mono-wrap">{JSON.stringify(run.outcome, null, 2)}</pre> : <p className="fdb-page__lead">No durable outcome exists for this state; no result is invented.</p>}
    <h3>Safety interpretation</h3>
    <ul className="fdb-list"><li>This is a local paper-only simulation outcome, not market evidence.</li><li>The browser displays durable authority projections and performs no conversion, cost, risk, fill, ledger, reconciliation, or outcome calculation.</li><li>Unknown or malformed states degrade and fail closed.</li></ul>
  </section>;
}

export default async function PaperWorkbenchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<JSX.Element> {
  const params = await searchParams;
  const selectedRunId = typeof params.runId === "string" ? params.runId : null;
  const store = await cookies();
  const session = store.get("fdb_session");
  const cookie = session ? `fdb_session=${session.value}` : undefined;
  const result = await fetchPaperWorkbench(cookie);
  if (!result.ok) return <div className="fdb-page"><h1>Paper and outcome workbench</h1><ErrorState title="Paper workbench unavailable" message={result.error} /></div>;
  const view = result.data;
  const detail = selectedRunId ? await fetchPaperRun(selectedRunId, cookie) : null;
  const candidate = view.activeCandidate;
  const criticalRisk = view.riskState?.state === "kill" || view.riskState?.state === "red";

  return <div className="fdb-page">
    <h1>Paper and outcome workbench</h1>
    <p className="fdb-paper-only" role="note"><strong>PAPER ONLY.</strong> Explicit operator confirmation is required. Opening, refreshing, or revisiting this page never submits a run.</p>
    {criticalRisk ? <section className="fdb-risk-critical" role="alert"><h2>{view.riskState?.state === "kill" ? "KILL IS ENGAGED" : "RED RISK STATE"}</h2><p>New paper risk must be rejected. This durable safety state is not a generic application error.</p></section> : null}

    <div className="fdb-grid">
      <section className="fdb-card" aria-labelledby="paper-candidate-heading"><h2 id="paper-candidate-heading">Active authoritative candidate</h2>
        {candidate ? <table className="fdb-table"><tbody>
          <tr><th scope="row">Signal</th><td className="fdb-mono-wrap">{candidate.signal.signalId}</td></tr>
          <tr><th scope="row">Instrument / timeframe</th><td>{candidate.signal.instrument} · {candidate.signal.timeframe}</td></tr>
          <tr><th scope="row">Direction / lifecycle</th><td>{candidate.signal.direction} / {candidate.lifecycleState}</td></tr>
          <tr><th scope="row">Signal / expiry UTC</th><td>{candidate.signal.eventTimeUtc}<br />{candidate.signal.expiresAtUtc}</td></tr>
          <tr><th scope="row">Reference / stop / target</th><td>{candidate.signal.referencePrice} / {candidate.signal.stopLoss} / {candidate.signal.takeProfit ?? "—"}</td></tr>
        </tbody></table> : <EmptyState title="No resolved active candidate" description="No verified R1.6 resolution is available. Submission remains disabled and no browser fallback is invented." />}
      </section>

      <section className="fdb-card" aria-labelledby="paper-input-heading"><h2 id="paper-input-heading">Verified R1.6 inputs</h2>
        {candidate ? <table className="fdb-table"><tbody>
          <tr><th scope="row">Resolution</th><td className="fdb-mono-wrap">{candidate.resolution.resolutionId}</td></tr>
          <tr><th scope="row">Verified at UTC</th><td>{candidate.resolution.checkedAtUtc}</td></tr>
          <tr><th scope="row">Execution dataset</th><td className="fdb-mono-wrap">{candidate.resolution.executionDataset.datasetId}<br />{candidate.resolution.executionDataset.artifactDigest}</td></tr>
          <tr><th scope="row">Conversion</th><td>{candidate.resolution.conversion.quoteCurrency} → USD · {candidate.resolution.conversion.method} · rate {candidate.resolution.conversion.conversionRate}</td></tr>
          <tr><th scope="row">Conversion lineage</th><td className="fdb-mono-wrap">{candidate.resolution.conversion.rateSource}<br />bar {candidate.resolution.conversion.sourceBarDigest}</td></tr>
          <tr><th scope="row">Registered spread / slippage</th><td>{candidate.resolution.costs.observedSpreadPips} / {candidate.resolution.costs.estimatedSlippagePips} pips</td></tr>
          <tr><th scope="row">Cost evidence</th><td><strong>Registered baseline assumption — not a provider observation</strong></td></tr>
        </tbody></table> : <p className="fdb-page__lead">Verified assumptions unavailable.</p>}
      </section>

      <section className="fdb-card" aria-labelledby="paper-confirm-heading"><h2 id="paper-confirm-heading">Explicit confirmation</h2><PaperConfirmationForm candidate={candidate} riskState={view.riskState?.state ?? null} /></section>
    </div>

    <section className="fdb-card" aria-labelledby="paper-runs-heading"><h2 id="paper-runs-heading">Durable paper runs ({view.runs.length})</h2>
      {view.runs.length === 0 ? <EmptyState title="No durable paper runs" description="An empty state is authoritative. No run is created until the explicit confirmation form is submitted." /> : <table className="fdb-table"><thead><tr><th>State</th><th>Run</th><th>Requested units</th><th>Risk verdict</th><th>Outcome</th><th>Detail</th></tr></thead><tbody>{view.runs.map((run) => <tr key={run.runId}><td><span className={statusClass(run.operatorState)}>{run.operatorState}</span></td><td className="fdb-mono-wrap">{run.runId}</td><td>{run.requestedQuantityUnits}</td><td>{run.riskDecision?.outcome ?? "unavailable"}</td><td>{run.outcome ? "paper-only outcome recorded" : "—"}</td><td><Link href={`/paper/workbench?runId=${encodeURIComponent(run.runId)}`}>Inspect via durable GET</Link></td></tr>)}</tbody></table>}
    </section>
    {detail?.ok ? <Detail run={detail.data} /> : null}
    {detail && !detail.ok ? <ErrorState title="Paper run detail unavailable" message={detail.error} /> : null}
  </div>;
}
