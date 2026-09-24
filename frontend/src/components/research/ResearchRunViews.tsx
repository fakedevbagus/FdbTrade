import Link from "next/link";
import type { JSX } from "react";

import { EmptyState } from "@/components/ui";
import type { ResearchRun } from "@/lib/research-workbench";

function statusClass(status: ResearchRun["status"]): string {
  if (status === "succeeded") return "fdb-badge fdb-badge--ok";
  if (status === "blocked" || status === "failed") return "fdb-badge fdb-badge--danger";
  return "fdb-badge fdb-badge--warn";
}

function number(value: number | null, digits = 4): string {
  return value === null ? "undefined (insufficient evidence)" : value.toFixed(digits);
}

export function ResearchRunList({ total, limit, runs }: {
  total: number;
  limit: number;
  runs: ResearchRun[];
}): JSX.Element {
  if (runs.length === 0) {
    return (
      <EmptyState
        title="No authoritative research runs"
        description="Choose an eligible registered dataset above. No legacy backtest or fabricated result is used as fallback."
      />
    );
  }
  return (
    <>
      <table className="fdb-table">
        <thead>
          <tr>
            <th scope="col">Lifecycle</th>
            <th scope="col">Dataset</th>
            <th scope="col">Created / updated UTC</th>
            <th scope="col">Frozen lineage</th>
            <th scope="col">Trades / net return</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const metrics = run.evidence?.empiricalEvidence.metrics ?? null;
            return (
              <tr key={run.authorityRunId}>
                <td><span className={statusClass(run.status)}>{run.status}</span><br /><small>attempts {run.attempts}</small></td>
                <td>{run.dataset.instrument} · {run.dataset.timeframe}<br /><small>{run.dataset.datasetId}</small></td>
                <td>{run.createdAtUtc}<br />{run.updatedAtUtc}</td>
                <td>{run.researchConfig.configVersion}<br /><small>{run.researchConfig.signalLogicVersion} / {run.researchConfig.signalConfigVersion}</small></td>
                <td>{metrics ? `${metrics.closedTrades} / ${number(metrics.netReturn)}` : "—"}</td>
                <td><Link href={`/research/workbench?runId=${encodeURIComponent(run.authorityRunId)}`}>Inspect</Link></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {total > limit ? <p className="fdb-page__lead">Showing the newest {limit} of {total} runs.</p> : null}
    </>
  );
}

export function ResearchRunDetail({ run }: { run: ResearchRun }): JSX.Element {
  const evidence = run.evidence;
  const metrics = evidence?.empiricalEvidence.metrics ?? null;
  const costs = evidence?.manifest?.costAssumptions ?? null;
  return (
    <section className="fdb-card" aria-labelledby="research-detail-heading">
      <h2 id="research-detail-heading">Research run detail</h2>
      <p><span className={statusClass(run.status)}>{run.status}</span>{" "}{run.authorityRunId}</p>

      <h3>Lifecycle and source lineage</h3>
      <table className="fdb-table"><tbody>
        <tr><th scope="row">Lifecycle</th><td>{run.status}; attempts {run.attempts}; created {run.createdAtUtc}; updated {run.updatedAtUtc}</td></tr>
        <tr><th scope="row">Failure / block reason</th><td>{run.failureReason ?? (evidence?.reasons.join(", ") || "—")}</td></tr>
        <tr><th scope="row">R0.6 dataset</th><td>{run.dataset.datasetId} · {run.dataset.instrument} · {run.dataset.timeframe} · {run.dataset.sourceMode}</td></tr>
        <tr><th scope="row">Dataset artifact SHA-256</th><td className="fdb-mono-wrap">{run.dataset.artifactDigest}</td></tr>
        <tr><th scope="row">Dataset quality / records</th><td>{run.dataset.qualityState} / {run.dataset.recordCount}</td></tr>
        <tr><th scope="row">Frozen baseline</th><td>{run.researchConfig.configId} {run.researchConfig.configVersion}</td></tr>
        <tr><th scope="row">Signal rule lineage</th><td>{run.researchConfig.signalRuleId} · logic {run.researchConfig.signalLogicVersion} · config {run.researchConfig.signalConfigVersion}</td></tr>
        <tr><th scope="row">Research config SHA-256</th><td className="fdb-mono-wrap">{run.researchConfig.configDigest}</td></tr>
      </tbody></table>

      <h3>Metrics</h3>
      {metrics ? (
        <table className="fdb-table"><tbody>
          <tr><th scope="row">Equity</th><td>{metrics.initialEquity} → {metrics.finalEquity}</td></tr>
          <tr><th scope="row">Net return / CAGR</th><td>{number(metrics.netReturn)} / {number(metrics.cagr)}</td></tr>
          <tr><th scope="row">Max drawdown / recovery bars</th><td>{number(metrics.maxDrawdown)} / {metrics.recoveryBars ?? "not recovered"}</td></tr>
          <tr><th scope="row">Sharpe / Sortino / Calmar</th><td>{number(metrics.sharpe)} / {number(metrics.sortino)} / {number(metrics.calmar)}</td></tr>
          <tr><th scope="row">Trades</th><td>{metrics.closedTrades} closed; {metrics.wins} wins; {metrics.losses} losses</td></tr>
          <tr><th scope="row">Expectancy / profit factor / average R</th><td>{number(metrics.expectancy)} / {number(metrics.profitFactor)} / {number(metrics.averageR)}</td></tr>
          <tr><th scope="row">MFE / MAE / turnover</th><td>{number(metrics.averageMfePips)} / {number(metrics.averageMaePips)} / {number(metrics.turnoverRatio)}</td></tr>
          <tr><th scope="row">Metric lineage</th><td>{metrics.metricsEngineId} {metrics.metricsEngineVersion}; {metrics.bars} bars</td></tr>
        </tbody></table>
      ) : <p className="fdb-page__lead">No metrics exist for this lifecycle state; none are inferred.</p>}

      <h3>Frozen cost assumptions</h3>
      {costs ? (
        <table className="fdb-table"><tbody>
          <tr><th scope="row">Policy / latency</th><td>{costs.policyId} / {costs.latencyBars} bar</td></tr>
          <tr><th scope="row">Spread / slippage / commission</th><td>{costs.spreadPips} / {costs.slippagePips} / {costs.commissionPips} pips</td></tr>
          <tr><th scope="row">Fill / ambiguity</th><td>max fraction {costs.maxFillFraction}; {costs.exitPriority}</td></tr>
          <tr><th scope="row">Seed</th><td>{evidence?.manifest?.seed}</td></tr>
        </tbody></table>
      ) : <p className="fdb-page__lead">No executed manifest exists for this blocked or failed run.</p>}

      <h3>Artifact lineage</h3>
      <table className="fdb-table"><tbody>
        <tr><th scope="row">Result / engine run</th><td>{run.artifact?.resultId ?? "—"} / {run.artifact?.engineRunId ?? "—"}</td></tr>
        <tr><th scope="row">Result artifact SHA-256</th><td className="fdb-mono-wrap">{run.artifact?.digest ?? "—"}</td></tr>
        <tr><th scope="row">Summary SHA-256</th><td className="fdb-mono-wrap">{run.artifact?.summaryDigest ?? "—"}</td></tr>
        <tr><th scope="row">Artifact bytes / recorded UTC</th><td>{run.artifact ? `${run.artifact.byteCount} / ${run.artifact.createdAtUtc}` : "—"}</td></tr>
        <tr><th scope="row">Engine</th><td>{evidence?.manifest ? `${evidence.manifest.engine.engineId} ${evidence.manifest.engine.engineVersion}` : "—"}</td></tr>
        <tr><th scope="row">Equity / trades SHA-256</th><td className="fdb-mono-wrap">{evidence?.manifest ? `${evidence.manifest.artifacts.equityDigest} / ${evidence.manifest.artifacts.tradesDigest}` : "—"}</td></tr>
      </tbody></table>

      <h3>Interpretation</h3>
      <ul className="fdb-list">
        <li><strong>Historical-only:</strong> this replay is not current or live evidence.</li>
        <li><strong>Uncalibrated:</strong> metrics do not create a signal-confidence value.</li>
        <li><strong>Non-promotion:</strong> this run cannot promote a strategy or model.</li>
        <li>No operational outcome, risk approval, paper order, provider call, or execution authority is created.</li>
      </ul>
    </section>
  );
}
