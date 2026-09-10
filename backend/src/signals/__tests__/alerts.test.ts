/**
 * Alert-center tests (P07-05).
 *
 * Acceptance: "Alert events are idempotent; failures are surfaced without
 * blocking signal creation." Covers: default preferences, validation
 * (malformed/missing input), idempotent dispatch (no duplicate record or
 * delivery), skipped-when-disabled, delivered via no-op, failure recording
 * without throwing, deterministic event ids, event list order.
 */
import { describe, expect, it, vi } from "vitest";

import {
  alertEventIdFor,
  alertPreferencesSchema,
  AlertCenter,
  DEFAULT_ALERT_PREFERENCES,
  noopAlertDelivery,
  type AlertDelivery,
} from "@/signals/alerts";

const DECISION = "ens_EURUSD_1h_2026-09-09T09:00:00.000Z";
const RECORDED = "2026-09-09T10:00:00.000Z";

const ENABLED_PREFS = {
  enabled: true,
  classes: { signal_created: true, signal_expired: false, decision_wait: false },
  channel: "noop" as const,
};

describe("alertPreferencesSchema", () => {
  it("valid input: defaults parse", () => {
    expect(alertPreferencesSchema.parse(DEFAULT_ALERT_PREFERENCES)).toEqual(
      DEFAULT_ALERT_PREFERENCES,
    );
  });

  it("malformed input: unknown class rejects", () => {
    expect(
      alertPreferencesSchema.safeParse({
        enabled: true,
        classes: { not_a_class: true },
        channel: "noop",
      }).success,
    ).toBe(false);
  });

  it("malformed input: unknown channel rejects", () => {
    expect(
      alertPreferencesSchema.safeParse({
        enabled: true,
        classes: { signal_created: true },
        channel: "whatsapp",
      }).success,
    ).toBe(false);
  });

  it("unknown key rejects (strict)", () => {
    expect(
      alertPreferencesSchema.safeParse({ ...DEFAULT_ALERT_PREFERENCES, extra: 1 })
        .success,
    ).toBe(false);
  });

  it("missing input: absent enabled rejects", () => {
    expect(alertPreferencesSchema.safeParse({ classes: {}, channel: "noop" }).success).toBe(
      false,
    );
  });
});


describe("AlertCenter", () => {
  it("defaults: disabled master switch skips delivery but records the event", async () => {
    const center = new AlertCenter();
    const outcome = await center.dispatch({
      decisionId: DECISION,
      eventClass: "signal_created",
      recordedAtUtc: RECORDED,
      message: "test",
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.skipped).toBe(true);
      expect(outcome.event.status).toBe("skipped");
      expect(outcome.event.attempts).toBe(0);
    }
    // Surfaced: the skip is listed, not silently dropped.
    expect(center.listEvents()).toHaveLength(1);
  });

  it("idempotency: repeated dispatch returns the SAME event, no duplicate delivery", async () => {
    const deliver = vi.fn(async () => ({ ok: true } as const));
    const delivery: AlertDelivery = { channel: "noop", deliver };
    const center = new AlertCenter({ delivery });
    center.setPreferences(ENABLED_PREFS);

    const first = await center.dispatch({
      decisionId: DECISION,
      eventClass: "signal_created",
      recordedAtUtc: RECORDED,
      message: "m",
    });
    const second = await center.dispatch({
      decisionId: DECISION,
      eventClass: "signal_created",
      recordedAtUtc: "2026-09-09T11:00:00.000Z",
      message: "m",
    });

    expect(first.ok && !first.idempotent).toBe(true);
    expect(second.ok && second.idempotent).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(center.listEvents()).toHaveLength(1);
    if (first.ok && second.ok) {
      expect(second.event.eventId).toBe(first.event.eventId);
      // The ORIGINAL recordedAtUtc wins (first write).
      expect(second.event.recordedAtUtc).toBe(RECORDED);
    }
  });

  it("different class or decision -> different event ids (no collision)", () => {
    const a = alertEventIdFor(DECISION, "signal_created");
    const b = alertEventIdFor(DECISION, "signal_expired");
    const c = alertEventIdFor("ens_XAUUSD_1h_2026-09-09T09:00:00.000Z", "signal_created");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("failure path: provider throw is recorded, dispatch never throws", async () => {
    const failing: AlertDelivery = {
      channel: "noop",
      async deliver() {
        throw new Error("SMTP socket refused");
      },
    };
    const center = new AlertCenter({ delivery: failing });
    center.setPreferences(ENABLED_PREFS);
    const outcome = await center.dispatch({
      decisionId: DECISION,
      eventClass: "signal_created",
      recordedAtUtc: RECORDED,
      message: "m",
    });
    // Acceptance: failure surfaced WITHOUT blocking (ok outcome, failed event).
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.event.status).toBe("failed");
      expect(outcome.event.lastError).toBe("SMTP socket refused");
      expect(outcome.event.attempts).toBe(1);
    }
  });

  it("failure path: provider reason (no throw) is recorded too", async () => {
    const refusing: AlertDelivery = {
      channel: "noop",
      async deliver() {
        return { ok: false, reason: "rate limited" };
      },
    };
    const center = new AlertCenter({ delivery: refusing });
    center.setPreferences(ENABLED_PREFS);
    const outcome = await center.dispatch({
      decisionId: DECISION,
      eventClass: "signal_created",
      recordedAtUtc: RECORDED,
      message: "m",
    });
    if (outcome.ok) {
      expect(outcome.event.status).toBe("failed");
      expect(outcome.event.lastError).toBe("rate limited");
    }
  });

  it("happy path: enabled preferences deliver via the no-op provider", async () => {
    const center = new AlertCenter({ delivery: noopAlertDelivery });
    center.setPreferences(ENABLED_PREFS);
    const outcome = await center.dispatch({
      decisionId: DECISION,
      eventClass: "signal_created",
      recordedAtUtc: RECORDED,
      message: "EURUSD long",
    });
    if (outcome.ok) {
      expect(outcome.event.status).toBe("delivered");
      expect(outcome.event.attempts).toBe(1);
      expect(outcome.event.lastError).toBeNull();
    }
  });

  it("listEvents is deterministic (recordedAtUtc then eventId)", async () => {
    const center = new AlertCenter();
    await center.dispatch({
      decisionId: "ens_AAA_1h_2026-09-09T09:00:00.000Z",
      eventClass: "signal_created",
      recordedAtUtc: "2026-09-09T11:00:00.000Z",
      message: "m",
    });
    await center.dispatch({
      decisionId: "ens_BBB_1h_2026-09-09T09:00:00.000Z",
      eventClass: "signal_created",
      recordedAtUtc: "2026-09-09T10:00:00.000Z",
      message: "m",
    });
    const events = center.listEvents();
    expect(events[0].decisionId).toBe("ens_BBB_1h_2026-09-09T09:00:00.000Z");
    expect(events[1].decisionId).toBe("ens_AAA_1h_2026-09-09T09:00:00.000Z");
  });

  it("empty boundary: fresh center has no events", () => {
    expect(new AlertCenter().listEvents()).toHaveLength(0);
  });

  it("setPreferences validates fail-closed (malformed input rejects)", () => {
    const center = new AlertCenter();
    expect(() =>
      center.setPreferences({ enabled: "yes", classes: {}, channel: "noop" }),
    ).toThrow();
  });
});
