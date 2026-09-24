import type { Metadata } from "next";
import { cookies } from "next/headers";
import type { JSX } from "react";

import { ResearchRunForm } from "@/components/research/ResearchRunForm";
import { ResearchRunDetail, ResearchRunList } from "@/components/research/ResearchRunViews";
import { EmptyState, ErrorState } from "@/components/ui";
import {
  eligibleResearchDatasets,
  fetchResearchRun,
  fetchResearchWorkbench,
} from "@/lib/research-workbench";

export const metadata: Metadata = { title: "Authoritative research workbench" };
export const dynamic = "force-dynamic";

export default async function ResearchWorkbenchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<JSX.Element> {
  const params = await searchParams;
  const selectedRunId = typeof params.runId === "string" ? params.runId : null;
  const store = await cookies();
  const session = store.get("fdb_session");
  const cookie = session ? `fdb_session=${session.value}` : undefined;
  const result = await fetchResearchWorkbench(cookie);

  if (!result.ok) {
    return <div className="fdb-page"><h1>Authoritative research workbench</h1><ErrorState title="Research workbench unavailable" message={result.error} /></div>;
  }

  const detail = selectedRunId ? await fetchResearchRun(selectedRunId, cookie) : null;
  const view = result.data;
  const eligible = eligibleResearchDatasets(view.datasets);
  const excludedCount = view.datasets.length - eligible.length;

  return (
    <div className="fdb-page">
      <h1>Authoritative research workbench</h1>
      <p className="fdb-page__lead">
        Explicitly run and reopen the single frozen R0.8 baseline through the R1.2 API.
        SQLite and verified content-addressed artifacts remain authority; this UI is projection-only.
      </p>

      <div className="fdb-grid">
        <section className="fdb-card" aria-labelledby="research-run-heading">
          <h2 id="research-run-heading">New baseline run</h2>
          <ResearchRunForm datasets={view.datasets} />
          {eligible.length === 0 ? (
            <EmptyState
              title="No eligible registered datasets"
              description="Register accepted R0.6 data with zero quarantined, gap, and duplicate observations. No fixture or legacy backtest fallback is invented."
            />
          ) : null}
          {excludedCount > 0 ? (
            <p className="fdb-page__lead">{excludedCount} registered dataset(s) are quality-blocked and excluded from new submissions.</p>
          ) : null}
        </section>

        <section className="fdb-card" aria-labelledby="research-boundaries-heading">
          <h2 id="research-boundaries-heading">Evidence boundary</h2>
          <ul className="fdb-list">
            <li>Exactly one frozen baseline configuration and deterministic rule</li>
            <li>Historical-only evidence with explicit costs and lineage</li>
            <li>Uncalibrated: no signal-confidence value</li>
            <li>Non-promotion: no strategy/model promotion authority</li>
            <li>No legacy backtest, risk/paper, provider, scheduler, demo, or live execution</li>
          </ul>
        </section>
      </div>

      <section className="fdb-card" aria-labelledby="research-runs-heading">
        <h2 id="research-runs-heading">Durable research runs ({view.researchRuns.total})</h2>
        <ResearchRunList {...view.researchRuns} />
      </section>

      {detail?.ok ? <ResearchRunDetail run={detail.data} /> : null}
      {detail && !detail.ok ? <ErrorState title="Research run detail unavailable" message={detail.error} /> : null}
    </div>
  );
}
