import type { Metadata } from "next";
import type { JSX } from "react";
import { cookies } from "next/headers";
import { EmptyState, ErrorState } from "@/components/ui";
import { fetchHistoricalDatasets } from "@/lib/historical";

export const metadata: Metadata = { title: "Historical datasets" };
export const dynamic = "force-dynamic";

export default async function HistoricalDatasetsPage(): Promise<JSX.Element> {
  const store = await cookies();
  const session = store.get("fdb_session");
  const result = await fetchHistoricalDatasets(session ? `fdb_session=${session.value}` : undefined);
  if (!result.ok) return <div className="fdb-page"><h1>Historical datasets</h1><ErrorState title="Historical datasets unavailable" message={result.error} /></div>;
  return <div className="fdb-page">
    <h1>Historical datasets</h1>
    <p className="fdb-page__lead">Mode: <span className="fdb-badge fdb-badge--warn">historical</span>. Operator-owned CSV only. Each dataset is immutable, checksum-verified, UTC-normalized, and never falls back to fixture data.</p>
    {result.datasets.length === 0 ? <EmptyState title="No historical datasets" description="Preview and explicitly confirm a CSV through POST /api/historical/datasets with confirm=false then confirm=true. Fixture and provider-shadow data are separate modes." /> :
      <table className="fdb-table"><thead><tr><th scope="col">Pair</th><th scope="col">Timeframe</th><th scope="col">Coverage UTC</th><th scope="col">Rows</th><th scope="col">Provenance</th><th scope="col">Quality</th></tr></thead><tbody>{result.datasets.map((dataset) => <tr key={dataset.datasetId}><td>{dataset.instrument}</td><td>{dataset.timeframe}</td><td>{dataset.periodStartUtc}<br />{dataset.periodEndUtc}</td><td>{dataset.recordCount}</td><td>{dataset.providerId}<br /><small>{dataset.checksum.slice(0, 16)}…</small></td><td>accepted={dataset.quality.accepted}; quarantined={dataset.quality.quarantined}; gaps={dataset.quality.gaps}; duplicates={dataset.quality.duplicates}</td></tr>)}</tbody></table>}
    <p className="fdb-page__lead">Historical research is simulation only. Live execution OFF. Provider order transport OFF.</p>
  </div>;
}
