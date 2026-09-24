"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type JSX, useMemo, useState, useTransition } from "react";

import {
  submitSignalEvaluation,
  type WorkbenchDataset,
} from "@/lib/signal-workbench";

export function SignalEvaluationForm({
  datasets,
}: {
  datasets: WorkbenchDataset[];
}): JSX.Element {
  const router = useRouter();
  const [datasetId, setDatasetId] = useState(datasets[0]?.datasetId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const selected = useMemo(
    () => datasets.find((dataset) => dataset.datasetId === datasetId) ?? null,
    [datasetId, datasets],
  );

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (!selected) {
      setError("Select a registered R0.6 dataset.");
      return;
    }
    const result = await submitSignalEvaluation({
      datasetId: selected.datasetId,
      assessedAtUtc: selected.assessedAtUtc,
    });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setMessage(result.data.executed
      ? `Evaluation recorded: ${result.data.outcome ?? result.data.status}.`
      : "Duplicate request reopened the existing durable evaluation.");
    startTransition(() => {
      router.push(`/signals/workbench?runId=${encodeURIComponent(result.data.runId)}`);
      router.refresh();
    });
  }

  return (
    <form className="fdb-workbench-form" onSubmit={submit}>
      <label htmlFor="signal-dataset">Registered R0.6 dataset</label>
      <select
        id="signal-dataset"
        value={datasetId}
        onChange={(event) => setDatasetId(event.target.value)}
        disabled={pending || datasets.length === 0}
        required
      >
        {datasets.length === 0 ? <option value="">No datasets available</option> : null}
        {datasets.map((dataset) => (
          <option key={dataset.datasetId} value={dataset.datasetId}>
            {dataset.instrument} · {dataset.timeframe} · {dataset.mode} · {dataset.qualityState}
          </option>
        ))}
      </select>
      <p className="fdb-page__lead">
        Assessment instant: {selected?.assessedAtUtc ?? "—"}. The backend uses
        the frozen authoritative-momentum-baseline rule; this form cannot edit it.
      </p>
      <button className="fdb-button" type="submit" disabled={pending || selected === null}>
        {pending ? "Evaluating…" : "Evaluate selected dataset"}
      </button>
      {message ? <p role="status">{message}</p> : null}
      {error ? <p className="fdb-badge--danger" role="alert">{error}</p> : null}
    </form>
  );
}
