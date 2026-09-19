"use client";

/**
 * Kill-switch + risk-state control form (P13-05).
 *
 * Client component: engages/releases the kill switch and forces risk states
 * through the backend controls API. The BACKEND enforces authentication,
 * RBAC (engage = operator+, release/force = admin) and audit — this form is
 * the UI surface only. Kill is never auto-reset; release lands conservatively
 * in red.
 */
import { useState } from "react";

import { performControlsAction } from "@/lib/controls";

const RISK_STATES = ["green", "yellow", "orange", "red"] as const;

export function KillSwitchForm({
  riskState,
  cookie,
}: {
  riskState: string;
  cookie?: string;
}): React.JSX.Element {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(payload: Parameters<typeof performControlsAction>[0]) {
    if (reason.trim().length < 3) {
      setError("A reason (min 3 chars) is required for every privileged action.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    const result = await performControlsAction({ ...payload, reason } as never, cookie);
    setBusy(false);
    if (result.ok) {
      setMessage("Action applied. The page refreshes on next load; every action is audited.");
      setReason("");
    } else {
      setError(result.error);
    }
  }

  return (
    <div className="fdb-list">
      <p>
        Current risk state: <strong>{riskState}</strong>. Kill is human-only
        and latched; release lands in red (never auto-green).
      </p>
      <label htmlFor="kill-reason">
        Reason (required, audited)
        <input
          id="kill-reason"
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={280}
          placeholder="e.g. incident #12 — feed outage"
          disabled={busy}
        />
      </label>
      <div>
        <button
          type="button"
          onClick={() => submit({ action: "engage_kill", reason })}
          disabled={busy || riskState === "kill"}
        >
          Engage kill switch
        </button>
        <button
          type="button"
          onClick={() => submit({ action: "release_kill", reason })}
          disabled={busy || riskState !== "kill"}
        >
          Release kill (to red)
        </button>
      </div>
      <div>
        {RISK_STATES.map((state) => (
          <button
            key={state}
            type="button"
            onClick={() => submit({ action: "force_risk_state", targetState: state, reason })}
            disabled={busy || riskState === state || riskState === "kill"}
          >
            Force {state}
          </button>
        ))}
      </div>
      {message !== null ? <p role="status">{message}</p> : null}
      {error !== null ? (
        <p role="alert" className="fdb-badge--danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
