"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type JSX, useRef, useState, useTransition } from "react";

import { confirmPaperRun, type ActivePaperCandidate } from "@/lib/paper-workbench";

export function PaperConfirmationForm({ candidate, riskState }: { candidate: ActivePaperCandidate | null; riskState: string | null }): JSX.Element {
  const router = useRouter();
  const locked = useRef(false);
  const [quantity, setQuantity] = useState(10_000);
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [navigating, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (locked.current || !candidate || !confirmed) return;
    locked.current = true;
    setSubmitting(true); setError(null); setMessage(null);
    const result = await confirmPaperRun(candidate.resolution.resolutionId, quantity);
    setSubmitting(false);
    if (!result.ok) { locked.current = false; setError(result.error); return; }
    setMessage(result.data.run.executed ? `Durable paper-only run recorded: ${result.data.run.operatorState}.` : "Existing durable paper-only run reopened; no duplicate run was created.");
    startTransition(() => {
      router.push(`/paper/workbench?runId=${encodeURIComponent(result.data.run.runId)}`);
      router.refresh();
    });
  }

  const pending = submitting || navigating;
  return <form className="fdb-workbench-form" onSubmit={submit}>
    <label htmlFor="paper-quantity">Requested quantity (units)</label>
    <input id="paper-quantity" type="number" min="1" step="1" value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} disabled={pending || !candidate} required />
    <p className="fdb-page__lead">Resolution: {candidate?.resolution.resolutionId ?? "unavailable"}. Current durable risk state: <strong>{riskState ?? "unavailable"}</strong>.</p>
    <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={pending || !candidate} /> I explicitly confirm one paper-only simulation using the durable inputs shown.</label>
    <button className="fdb-button" type="submit" disabled={pending || !candidate || !confirmed || !Number.isFinite(quantity) || quantity <= 0}>{pending ? "Confirming paper-only run…" : "Confirm paper-only run"}</button>
    {message ? <p role="status">{message}</p> : null}
    {error ? <p className="fdb-badge--danger" role="alert">{error}</p> : null}
  </form>;
}
