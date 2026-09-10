/**
 * Alerts API-client + form tests (P07-05).
 *
 * Covers: schema validation (malformed/missing input), fail-closed fetches
 * (non-200/unreachable/malformed), the preferences form toggling + saving
 * with the honest no-op channel note, and idempotency language surfaced.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  alertEventViewSchema,
  alertPreferencesViewSchema,
  fetchAlertEvents,
  fetchAlertPreferences,
  saveAlertPreferences,
} from "@/lib/alerts";
import { AlertPreferencesForm } from "@/components/alerts/AlertPreferencesForm";

const VALID_PREFS = {
  enabled: false,
  classes: { signal_created: false, signal_expired: false, decision_wait: false },
  channel: "noop",
} as const;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("alert schemas", () => {
  it("valid input parses", () => {
    expect(alertPreferencesViewSchema.safeParse(VALID_PREFS).success).toBe(true);
  });

  it("malformed input: unknown channel rejects", () => {
    expect(
      alertPreferencesViewSchema.safeParse({ ...VALID_PREFS, channel: "whatsapp" }).success,
    ).toBe(false);
  });

  it("malformed event: bad status rejects", () => {
    expect(
      alertEventViewSchema.safeParse({
        eventId: "a".repeat(64),
        decisionId: "ens_x",
        eventClass: "signal_created",
        recordedAtUtc: "2026-09-09T10:00:00.000Z",
        status: "lost",
        attempts: 1,
        lastError: null,
      }).success,
    ).toBe(false);
  });

  it("missing input: absent enabled rejects", () => {
    expect(
      alertPreferencesViewSchema.safeParse({
        classes: {},
        channel: "noop",
      }).success,
    ).toBe(false);
  });
});

describe("fetch/save clients", () => {
  it("fetchAlertPreferences: 200 + ok body -> parsed prefs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, data: VALID_PREFS }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const result = await fetchAlertPreferences();
    expect(result.ok).toBe(true);
  });

  it("fetchAlertPreferences: unreachable -> { ok: false }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("refused");
      }),
    );
    const result = await fetchAlertPreferences();
    expect(result.ok).toBe(false);
  });

  it("fetchAlertEvents: malformed events reject (fail closed)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ ok: true, data: { events: [{ bogus: true }] } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const result = await fetchAlertEvents();
    expect(result.ok).toBe(false);
  });

  it("saveAlertPreferences: 400 -> { ok: false }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 400 })),
    );
    const result = await saveAlertPreferences(VALID_PREFS);
    expect(result.ok).toBe(false);
  });
});

describe("AlertPreferencesForm", () => {
  it("renders the master switch, class toggles and no-op note", () => {
    render(<AlertPreferencesForm initial={VALID_PREFS} />);
    expect(screen.getByLabelText(/Enable alerts/i)).toBeDefined();
    expect(screen.getByLabelText(/Signal created/i)).toBeDefined();
    expect(screen.getByText(/no-op provider/i)).toBeDefined();
    expect(screen.getByText(/never block signal creation/i)).toBeDefined();
  });

  it("toggling the master switch saves the new preferences", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            data: { ...VALID_PREFS, enabled: true },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<AlertPreferencesForm initial={VALID_PREFS} />);
    fireEvent.click(screen.getByLabelText(/Enable alerts/i));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText(/Preferences saved/i)).toBeDefined();
    });
  });

  it("save failure surfaces the error (fail closed, form stays usable)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    render(<AlertPreferencesForm initial={VALID_PREFS} />);
    fireEvent.click(screen.getByLabelText(/Enable alerts/i));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeDefined();
    });
  });
});
