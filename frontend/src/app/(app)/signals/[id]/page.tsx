/**
 * Signal detail page (P07-03).
 *
 * Shows BUY/SELL/WAIT, entry zone (reference/entry), SL/TP, R:R (labeled
 * derived), expected move, confidence (separate from calibration hit-rate),
 * reasons, regime context, data quality, strategy performance context
 * (honest: none until P8/P12) and expiry. Every claim maps to a stored
 * decision/signal field or an explicitly labeled derived number.
 * No misleading certainty: confidence is model certainty, NEVER a win
 * probability; hit-rate absence is shown, never invented.
 */
import type { Metadata } from "next";
import type { JSX } from "react";
import { cookies } from "next/headers";

import { ErrorState, FreshnessBadge } from "@/components/ui";
import { latestAsOfUtc } from "@/lib/scanner";
import { fetchSignalDetail, type SignalDetailViewData } from "@/lib/signal-detail";

export const metadata: Metadata = {
  title: "Signal detail",
};

export const dynamic = "force-dynamic";

function actionHeadline(action: SignalDetailViewData["decision"]["action"]): string {
  return action === "enter_long"
    ? "BUY (enter long)"
    : action === "enter_short"
      ? "SELL (enter short)"
      : "WAIT (no trade — explained)";
}

function fmt(value: number | null | undefined, digits = 5): string {
  return typeof value === "number" ? value.toFixed(digits) : "—";
}

export default async function SignalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<JSX.Element> {
  const { id } = await params;
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("fdb_session");
  const cookie = sessionCookie ? `fdb_session=${sessionCookie.value}` : undefined;
  const asOfUtc = await latestAsOfUtc();

  const result = await fetchSignalDetail(id, asOfUtc, cookie);
  if (!result.ok) {
    return (
      <div className="fdb-page">
        <h1>Signal detail</h1>
        <ErrorState
          title={result.notFound ? "Signal not found" : "Detail unavailable"}
          message={result.error}
          hint={`Evaluated as of ${asOfUtc} (UTC).`}
        />
      </div>
    );
  }

  const detail = result.data;
  const d = detail.decision;
  const dominantSignal =
    d.dominantStrategyId !== null
      ? (detail.votes.find(
          (v) => v.strategyId === d.dominantStrategyId && v.signal !== null,
        )?.signal ?? null)
      : null;

  // Risk:reward — derived from stored levels, labeled derived.
  const rr =
    dominantSignal !== null && dominantSignal.takeProfit !== null
      ? Math.abs(dominantSignal.takeProfit - dominantSignal.referencePrice) /
        Math.abs(dominantSignal.referencePrice - dominantSignal.stopLoss)
      : null;

  const cal = d.confidenceComponents.calibration;

  return (
    <div className="fdb-page">
      <h1>{actionHeadline(d.action)}</h1>
      <p className="fdb-page__lead">
        {d.instrument} · {d.timeframe} · decision {d.decisionId} · event bar{" "}
        {d.eventTimeUtc} (UTC). Decision hash {d.decisionHash.slice(0, 16)}… ·
        weights v{d.weightsVersion}. Live execution is OFF.
      </p>
      <div className="fdb-grid">
        <section className="fdb-card" aria-labelledby="sd-plan">
          <h2 id="sd-plan">Trade plan</h2>
          {dominantSignal === null ? (
            <p className="fdb-empty">
              No directional plan: this decision is WAIT with reason codes{" "}
              {d.reasonCodes.join(", ")}. Absence of a trade is explained, never
              an error.
            </p>
          ) : (
            <table className="fdb-table">
              <tbody>
                <tr>
                  <th scope="row">Entry style</th>
                  <td>{dominantSignal.entryType}</td>
                </tr>
                <tr>
                  <th scope="row">Entry zone (reference)</th>
                  <td>{fmt(dominantSignal.entryPrice ?? dominantSignal.referencePrice)}</td>
                </tr>
                <tr>
                  <th scope="row">Stop loss</th>
                  <td>{fmt(dominantSignal.stopLoss)}</td>
                </tr>
                <tr>
                  <th scope="row">Take profit</th>
                  <td>{fmt(dominantSignal.takeProfit)}</td>
                </tr>
                <tr>
                  <th scope="row">Risk:reward (derived)</th>
                  <td>{rr === null ? "—" : `${rr.toFixed(2)} : 1`}</td>
                </tr>
                <tr>
                  <th scope="row">Expected move (derived)</th>
                  <td>
                    {detail.edge.expectedMovePips === null
                      ? "—"
                      : `${detail.edge.expectedMovePips.toFixed(1)} pips to target`}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Cost floor (derived)</th>
                  <td>
                    {detail.edge.costFloorPips === null
                      ? "—"
                      : `${detail.edge.costFloorPips.toFixed(1)} pips round trip`}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Net edge (derived)</th>
                  <td>
                    {detail.edge.netEdgePips === null
                      ? "—"
                      : `${detail.edge.netEdgePips.toFixed(1)} pips`}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Expires (UTC)</th>
                  <td>{detail.expiry.expiresAtUtc ?? "—"}</td>
                </tr>
              </tbody>

        <section className="fdb-card" aria-labelledby="sd-confidence">
          <h2 id="sd-confidence">Confidence &amp; calibration</h2>
          <table className="fdb-table">
            <tbody>
              <tr>
                <th scope="row">Ensemble confidence</th>
                <td>{d.confidence.toFixed(3)}</td>
              </tr>
              <tr>
                <th scope="row">Empirical hit-rate</th>
                <td>
                  {cal.empiricalHitRate === null
                    ? "No outcomes recorded yet (uncalibrated)"
                    : `${cal.empiricalHitRate.toFixed(3)} over ${cal.sampleSize} outcomes`}
                </td>
              </tr>
              <tr>
                <th scope="row">Uncertainty flags</th>
                <td>
                  {cal.uncertaintyFlags.length > 0 ? cal.uncertaintyFlags.join(", ") : "—"}
                </td>
              </tr>
              <tr>
                <th scope="row">Vote agreement</th>
                <td>{d.confidenceComponents.voteAgreement.toFixed(3)}</td>
              </tr>
              <tr>
                <th scope="row">Weighted agreement</th>
                <td>{d.confidenceComponents.weightedAgreement.toFixed(3)}</td>
              </tr>
              <tr>
                <th scope="row">Regime alignment</th>
                <td>{d.confidenceComponents.regimeAlignment.toFixed(3)}</td>
              </tr>
              <tr>
                <th scope="row">Correlation penalty</th>
                <td>{d.confidenceComponents.correlationPenalty.toFixed(3)}</td>
              </tr>
            </tbody>
          </table>
          <p className="fdb-page__lead">
            Confidence is model certainty in [0,1] — NOT a win probability and
            never a profit guarantee. The empirical hit-rate is a measured
            frequency over recorded outcomes only.
          </p>
        </section>

        <section className="fdb-card" aria-labelledby="sd-reasons">
          <h2 id="sd-reasons">Reasons</h2>
          <ul className="fdb-list">
            {d.reasonCodes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
        </section>

            </table>
          )}
        </section>

      ? Math.abs(dominantSignal.takeProfit - dominantSignal.referencePrice) /
        Math.abs(dominantSignal.referencePrice - dominantSignal.stopLoss)

        <section className="fdb-card" aria-labelledby="sd-regime">
          <h2 id="sd-regime">Regime context</h2>
          <table className="fdb-table">
            <thead>
              <tr>
                <th scope="col">Timeframe</th>
                <th scope="col">State</th>
                <th scope="col">Confidence</th>
                <th scope="col">Closed bar (UTC)</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {detail.regimeContext.entries.map((entry) => (
                <tr key={entry.timeframe} className={entry.stale ? "fdb-row--stale" : undefined}>
                  <td>{entry.timeframe}</td>
                  <td>{entry.state}</td>
                  <td>{entry.confidence.toFixed(3)}</td>
                  <td>{entry.closedAtUtc ?? "—"}</td>
                  <td>{entry.stale ? "Stale/degraded" : "Ready"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="fdb-card" aria-labelledby="sd-quality">
          <h2 id="sd-quality">Data quality</h2>
          <p>
            <FreshnessBadge
              stale={!detail.dataQuality.fresh}
              barsBehind={detail.dataQuality.barsBehind}
            />{" "}
            {detail.dataQuality.fresh
              ? "Decision derives from the latest closed bar."
              : `Decision bar is ${detail.dataQuality.barsBehind} bars behind the as-of bar.`}
            {detail.dataQuality.degradedContext
              ? " Higher-timeframe regime context is degraded (fail closed)."
              : ""}
          </p>
        </section>

        <section className="fdb-card" aria-labelledby="sd-votes">
          <h2 id="sd-votes">Strategy votes (verbatim evidence)</h2>
          <table className="fdb-table">
            <thead>
              <tr>
                <th scope="col">Strategy</th>
                <th scope="col">Version</th>
                <th scope="col">Stance</th>
                <th scope="col">Confidence</th>
                <th scope="col">Reasons</th>
              </tr>
            </thead>
            <tbody>
              {detail.votes.map((vote) => (
                <tr key={vote.strategyId}>
                  <td>{vote.strategyId}</td>
                  <td>
                    {vote.strategyVersion} / cfg {vote.configVersion}
                  </td>
                  <td>{vote.stance}</td>
                  <td>{vote.confidence.toFixed(2)}</td>
                  <td>{vote.reasonCodes.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="fdb-page__lead">
            Every vote is preserved verbatim from the evaluation (evidence is
            never hidden — ADR-0018).
          </p>
        </section>

        <section className="fdb-card" aria-labelledby="sd-performance">
          <h2 id="sd-performance">Strategy performance context</h2>
          <p className="fdb-empty">{detail.performanceContext.note}</p>
        </section>
      </div>
    </div>
  );
}
