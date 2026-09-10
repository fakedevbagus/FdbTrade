/**
 * Alert center page (P07-05).
 *
 * In-app alert preferences (master switch + per-class toggles, no-op
 * provider) and the recorded alert-event log — delivery failures are
 * surfaced with their structured reason, never hidden. Read-only event
 * view: no client-triggered dispatch exists (alert creation belongs to the
 * pipeline; no WhatsApp automation — prompt non-goal).
 */
import type { Metadata } from "next";
import type { JSX } from "react";
import { cookies } from "next/headers";

import { AlertPreferencesForm } from "@/components/alerts/AlertPreferencesForm";
import { EmptyState, ErrorState } from "@/components/ui";
import { fetchAlertEvents, fetchAlertPreferences } from "@/lib/alerts";

export const metadata: Metadata = {
  title: "Alert center",
};

export const dynamic = "force-dynamic";

const STATUS_BADGES: Record<string, string> = {
  delivered: "fdb-badge--ok",
  failed: "fdb-badge--danger",
  pending: "fdb-badge--warn",
  skipped: "fdb-badge--warn",
};

export default async function AlertsPage(): Promise<JSX.Element> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("fdb_session");
  const cookie = sessionCookie ? `fdb_session=${sessionCookie.value}` : undefined;

  const [prefsResult, eventsResult] = await Promise.all([
    fetchAlertPreferences(cookie),
    fetchAlertEvents(cookie),
  ]);

  if (!prefsResult.ok || !eventsResult.ok) {
    const message = !prefsResult.ok
      ? prefsResult.error
      : (eventsResult as { ok: false; error: string }).error;
    return (
      <div className="fdb-page">
        <h1>Alert center</h1>
        <ErrorState title="Alert center unavailable" message={message} />
      </div>
    );
  }

  const events = eventsResult.data;

  return (
    <div className="fdb-page">
      <h1>Alert center</h1>
      <div className="fdb-grid">
        <section className="fdb-card" aria-labelledby="al-prefs">
          <h2 id="al-prefs">Alert preferences</h2>
          <AlertPreferencesForm initial={prefsResult.data} cookie={cookie} />
        </section>
        <section className="fdb-card" aria-labelledby="al-events">
          <h2 id="al-events">Alert events ({events.length})</h2>
          {events.length === 0 ? (
            <EmptyState
              title="No alert events yet"
              description="Events appear here when the pipeline dispatches alerts. Failures are recorded with their reason — never silently dropped."
            />
          ) : (
            <table className="fdb-table">
              <thead>
                <tr>
                  <th scope="col">Event class</th>
                  <th scope="col">Decision</th>
                  <th scope="col">Recorded (UTC)</th>
                  <th scope="col">Status</th>
                  <th scope="col">Attempts</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.eventId}>
                    <td>{event.eventClass}</td>
                    <td>{event.decisionId}</td>
                    <td>{event.recordedAtUtc}</td>
                    <td>
                      <span className={`fdb-badge ${STATUS_BADGES[event.status] ?? ""}`}>
                        {event.status}
                      </span>
                    </td>
                    <td>{event.attempts}</td>
                    <td>{event.lastError ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="fdb-page__lead">
            Alert dispatch is idempotent per (decision, event class); a
            delivery failure never blocks signal creation.
          </p>
        </section>
      </div>
    </div>
  );
}
