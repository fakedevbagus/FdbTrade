"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type JSX, useMemo, useState, useTransition } from "react";

import {
  eligibleResearchDatasets,
  submitResearchRun,
  type ResearchDataset,
} from "@/lib/research-workbench";

export function ResearchRunForm({ datasets }: { datasets: ResearchDataset[] }): JSX.Element {
  const router = useRouter();
  const eligible = useMemo(() => eligibleResearchDatasets(datasets), [datasets]);
  const [datasetId, setDatasetId] = useState(eligible[0]?.datasetId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [navigating, startTransition] = useTransition();
  const selected = eligible.find((dataset) => dataset.datasetId === datasetId) ?? null;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (!selected) {
      setError("Select an eligible registered R0.6 dataset.");
      return;
    }
    setSubmitting(true);
    const result = await submitResearchRun({
      datasetId: selected.datasetId,
      createdAtUtc: new Date().toISOString(),
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setMessage(result.data.executed
      ? `Frozen baseline run recorded: ${result.data.run.status}.`
      : "Duplicate request reopened the existing durable research run.");
    startTransition(() => {
      router.push(`/research/workbench?runId=${encodeURIComponent(result.data.run.authorityRunId)}`);
      router.refresh();
    });
  }

  const pending = submitting || navigating;
  return (
    <form className="fdb-workbench-form" onSubmit={submit}>
      <label htmlFor="research-dataset">Eligible registered R0.6 dataset</label>
      <select
        id="research-dataset"
        value={datasetId}
        onChange={(event) => setDatasetId(event.target.value)}
        disabled={pending || eligible.length === 0}
        required
      >
        {eligible.length === 0 ? <option value="">No eligible datasets</option> : null}
        {eligible.map((dataset) => (
          <option key={dataset.datasetId} value={dataset.datasetId}>
            {dataset.instrument} · {dataset.timeframe} · {dataset.mode} · {dataset.recordCount} bars
          </option>
        ))}
      </select>
      <p className="fdb-page__lead">
        {selected
          ? `Source ${selected.providerId}; ${selected.periodStartUtc} to ${selected.periodEndUtc}.`
          : "Datasets with quarantine, gaps, or duplicates cannot be submitted."}
        {" "}The baseline, costs, seed, quantity, warmup, and one-bar latency are frozen.
      </p>
      <button className="fdb-button" type="submit" disabled={pending || selected === null}>
        {pending ? "Running frozen baseline…" : "Run frozen baseline"}
      </button>
      {message ? <p role="status">{message}</p> : null}
      {error ? <p className="fdb-badge--danger" role="alert">{error}</p> : null}
    </form>
  );
}
