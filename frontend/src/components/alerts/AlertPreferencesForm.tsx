"use client";

/**
 * Alert preferences form (P07-05).
 *
 * Client component: toggles the in-app alert preferences (master switch +
 * per event class). Saving PUTs the validated object to the BFF; server
 * validates again (fail closed). The channel is the no-op provider — the
 * UI says so honestly. Preferences gate alert delivery ONLY: they never
 * create, modify or block signals.
 */
import type { JSX } from "react";
import { useState } from "react";

import {
  type AlertPreferencesView,
  saveAlertPreferences,
} from "@/lib/alerts";

const CLASS_LABELS: Record<string, string> = {
  signal_created: "Signal created",
  signal_expired: "Signal expired",
  decision_wait: "WAIT decision",
};

export function AlertPreferencesForm({
  initial,
  cookie,
}: {
  initial: AlertPreferencesView;
  cookie?: string;
}): JSX.Element {
  const [prefs, setPrefs] = useState<AlertPreferencesView>(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState<string>("");

  async function save(next: AlertPreferencesView): Promise<void> {
    setStatus("saving");
    setPrefs(next);
    const result = await saveAlertPreferences(next, cookie);
    if (result.ok) {
      setPrefs(result.data);
      setStatus("saved");
      setMessage("Preferences saved.");
    } else {
      setStatus("error");
      setMessage(result.error);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
      }}
    >
      <p className="fdb-page__lead">
        Delivery channel: no-op provider (records events, sends nothing
        anywhere). Email/Telegram adapters arrive in later phases behind the
        same abstraction. Alerts never block signal creation.
      </p>
      <label>
        <input
          type="checkbox"
          checked={prefs.enabled}
          onChange={(e) => save({ ...prefs, enabled: e.target.checked })}
        />{" "}
        Enable alerts (master switch)
      </label>
      <ul className="fdb-list">
        {Object.keys(CLASS_LABELS).map((classKey) => (
          <li key={classKey}>
            <label>
              <input
                type="checkbox"
                checked={prefs.classes[classKey as keyof typeof prefs.classes] === true}
                onChange={(e) =>
                  save({
                    ...prefs,
                    classes: {
                      ...prefs.classes,
                      [classKey]: e.target.checked,
                    },
                  })
                }
              />{" "}
              {CLASS_LABELS[classKey]}
            </label>
          </li>
        ))}
      </ul>
      {status !== "idle" ? (
        <p
          className="fdb-page__lead"
          role={status === "error" ? "alert" : "status"}
        >
          {status === "saving" ? "Saving…" : message}
        </p>
      ) : null}
    </form>
  );
}

export default AlertPreferencesForm;
