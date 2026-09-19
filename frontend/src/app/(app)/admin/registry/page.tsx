/**
 * Admin registry page (P13-03).
 *
 * Read-only admin view over the strategy/model registry: versioned entries,
 * dataset refs, config hashes, model metadata, champion/challenger state,
 * explicit limitations and linked research runs. NO promote action exists in
 * the UI — lifecycle changes require P09 evidence gates (server-side); the
 * page states that explicitly.
 */
import type { Metadata } from "next";
import type { JSX } from "react";
import { cookies } from "next/headers";

import { EmptyState, ErrorState } from "@/components/ui";
import { fetchRegistry } from "@/lib/registry";

export const metadata: Metadata = {
  title: "Registry",
};

export const dynamic = "force-dynamic";

const STATE_BADGES: Record<string, string> = {
  champion: "fdb-badge--ok",
  challenger: "fdb-badge--warn",
  candidate: "fdb-badge--warn",
  retired: "fdb-badge--danger",
  rejected: "fdb-badge--danger",
};

export default async function RegistryPage(): Promise<JSX.Element> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("fdb_session");
  const cookie = sessionCookie ? `fdb_session=${sessionCookie.value}` : undefined;

  const result = await fetchRegistry(cookie);
  if (!result.ok) {
    return (
      <div className="fdb-page">
        <h1>Registry</h1>
        <ErrorState title="Registry unavailable" message={result.error} />
      </div>
    );
  }

  const { count, champions, entries } = result.data;

  return (
    <div className="fdb-page">
      <h1>Registry</h1>
      <p className="fdb-page__lead">
        {count} registered artifact {count === 1 ? "version" : "versions"}. Champions:{" "}
        {champions.length > 0 ? champions.join(", ") : "none"}. Promotion requires
        research evidence (P09 gates); this page is read-only.
      </p>
      {entries.length === 0 ? (
        <EmptyState
          title="No registered artifacts"
          description="Artifacts appear here when a strategy or model version is registered with dataset, config-hash and research-run lineage."
        />
      ) : (
        <table className="fdb-table">
          <thead>
            <tr>
              <th scope="col">Artifact</th>
              <th scope="col">Kind</th>
              <th scope="col">State</th>
              <th scope="col">Dataset</th>
              <th scope="col">Config hash</th>
              <th scope="col">Research runs</th>
              <th scope="col">Registered (UTC)</th>
              <th scope="col">Limitations</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.entryId}>
                <td>{entry.artifactId}</td>
                <td>{entry.kind}</td>
                <td>
                  <span className={`fdb-badge ${STATE_BADGES[entry.state] ?? ""}`}>
                    {entry.state}
                  </span>
                </td>
                <td>
                  {entry.dataset.datasetId}
                  <br />
                  <small>{entry.dataset.digest.slice(0, 16)}…</small>
                </td>
                <td>
                  <small>{entry.configHash.slice(0, 16)}…</small>
                </td>
                <td>{entry.researchRunIds.length > 0 ? entry.researchRunIds.join(", ") : "—"}</td>
                <td>{entry.registeredAtUtc}</td>
                <td>
                  <small>{entry.limitations}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="fdb-page__lead">
        Model entries carry training lineage (feature set, train dataset
        digest, hyperparameters). ML production remains disabled until the
        champion gate passes.
      </p>
    </div>
  );
}
