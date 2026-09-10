/**
 * Alert preferences + delivery abstraction (P07-05, no-op provider first).
 *
 * Design:
 * - `AlertPreferences`: the single user's per-event-class toggles. Validated
 *   at the boundary (zod), stored in-memory (durable store is a later
 *   phase's swap — same contract).
 * - `AlertEvent`: one alert for one decisionId + event class. Delivery is
 *   IDEMPOTENT by `eventId` (sha256 of decisionId|class): re-dispatching
 *   the same event never duplicates, never re-sends.
 * - `AlertDelivery`: provider abstraction. The only implementation now is
 *   the NO-OP provider (records, sends nothing). Email/Telegram adapters
 *   arrive later behind this same interface — they receive events, they
 *   never receive credentials from source, and they can NEVER create,
 *   modify or block signals (delivery failure is recorded, never thrown
 *   upstream — signal creation stays unblocked).
 * - Failures are surfaced on the event record (status + attempts +
 *   lastError), never silently dropped.
 *
 * Deterministic: no wall clock in dispatch logic (timestamps are
 * caller-supplied); the same events + prefs yield the same outcomes.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

export const ALERT_EVENT_CLASSES = [
  "signal_created",
  "signal_expired",
  "decision_wait",
] as const;
export type AlertEventClass = (typeof ALERT_EVENT_CLASSES)[number];
export const alertEventClassSchema = z.enum(ALERT_EVENT_CLASSES);

export const ALERT_DELIVERY_STATUSES = [
  "pending",
  "delivered",
  "failed",
  "skipped",
] as const;
export type AlertDeliveryStatus = (typeof ALERT_DELIVERY_STATUSES)[number];
export const alertDeliveryStatusSchema = z.enum(ALERT_DELIVERY_STATUSES);

/** Delivery channels (no-op only for now; later phases add providers). */
export const ALERT_CHANNELS = ["noop"] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];
export const alertChannelSchema = z.enum(ALERT_CHANNELS);

/** The user's alert preferences (per event class, enabled or not). */
export const alertPreferencesSchema = z
  .object({
    /** True when any alert is enabled at all (master switch). */
    enabled: z.boolean(),
    /** Event classes the user wants to hear about. */
    classes: z.record(alertEventClassSchema, z.boolean()),
    /** Delivery channel (no-op provider only for now). */
    channel: alertChannelSchema,
  })
  .strict()
  .refine(
    (p) =>
      Object.keys(p.classes).every(
        (c) => (ALERT_EVENT_CLASSES as readonly string[]).includes(c),
      ),
    { message: "classes may only contain known event classes", path: ["classes"] },
  );

export type AlertPreferences = z.infer<typeof alertPreferencesSchema>;

export const DEFAULT_ALERT_PREFERENCES: AlertPreferences = {
  enabled: false,
  classes: {
    signal_created: false,
    signal_expired: false,
    decision_wait: false,
  },
  channel: "noop",
};

/** Deterministic event id: sha256(decisionId|class). */
export function alertEventIdFor(decisionId: string, eventClass: AlertEventClass): string {
  return createHash("sha256")
    .update(`${decisionId}|${eventClass}`)
    .digest("hex");
}


/** One recorded alert event (immutable identity, mutable delivery status). */
export interface AlertEvent {
  eventId: string;
  decisionId: string;
  eventClass: AlertEventClass;
  /** UTC instant the event was recorded (caller-supplied, never wall clock). */
  recordedAtUtc: string;
  status: AlertDeliveryStatus;
  /** Delivery attempts so far (>= 0). */
  attempts: number;
  /** Structured failure detail (null unless status failed). */
  lastError: string | null;
}

/** The delivery-provider interface (no-op now; email/Telegram later). */
export interface AlertDelivery {
  readonly channel: AlertChannel;
  /** Deliver one alert; never throws — failures return a reason string. */
  deliver(
    event: AlertEvent,
    message: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
}

/** The no-op provider: records the intent, sends nothing anywhere. */
export const noopAlertDelivery: AlertDelivery = {
  channel: "noop",
  async deliver() {
    return { ok: true };
  },
};

export type DispatchOutcome =
  | { ok: true; event: AlertEvent; idempotent: boolean; skipped: boolean }
  | { ok: false; reason: string };

/**
 * The alert center: in-memory preference + event store with idempotent
 * dispatch. Constructing it never calls any execution path; a dispatch
 * failure is RECORDED, never thrown — signal creation cannot be blocked by
 * alert delivery (acceptance criterion).
 */
export class AlertCenter {
  private readonly delivery: AlertDelivery;
  private preferences: AlertPreferences;
  private readonly events = new Map<string, AlertEvent>();

  constructor(options: { delivery?: AlertDelivery } = {}) {
    this.delivery = options.delivery ?? noopAlertDelivery;
    this.preferences = alertPreferencesSchema.parse(DEFAULT_ALERT_PREFERENCES);
  }

  getPreferences(): AlertPreferences {
    return this.preferences;
  }

  /** Set (validate + replace) the preferences. Returns the stored value. */
  setPreferences(raw: unknown): AlertPreferences {
    this.preferences = alertPreferencesSchema.parse(raw);
    return this.preferences;
  }

  /** All recorded events, deterministic order (recordedAtUtc then eventId). */
  listEvents(): AlertEvent[] {
    return [...this.events.values()].sort((a, b) =>
      a.recordedAtUtc === b.recordedAtUtc
        ? a.eventId < b.eventId
          ? -1
          : 1
        : a.recordedAtUtc < b.recordedAtUtc
          ? -1
          : 1,
    );
  }

  /**
   * Dispatch one alert. Idempotent by (decisionId, eventClass): a repeated
   * dispatch returns the EXISTING event with `idempotent: true` (no
   * duplicate record, no duplicate delivery). Disabled preferences skip
   * delivery (`skipped` status, still recorded — failures/skips are
   * surfaced, never silently dropped).
   */
  async dispatch(options: {
    decisionId: string;
    eventClass: AlertEventClass;
    recordedAtUtc: string;
    message: string;
  }): Promise<DispatchOutcome> {
    const eventId = alertEventIdFor(options.decisionId, options.eventClass);
    const existing = this.events.get(eventId);
    if (existing) {
      return { ok: true, event: existing, idempotent: true, skipped: false };
    }
    const event: AlertEvent = {
      eventId,
      decisionId: options.decisionId,
      eventClass: options.eventClass,
      recordedAtUtc: options.recordedAtUtc,
      status: "pending",
      attempts: 0,
      lastError: null,
    };

    const classEnabled = this.preferences.classes[options.eventClass] === true;
    const enabled = this.preferences.enabled && classEnabled;
    if (!enabled) {
      event.status = "skipped";
      this.events.set(eventId, event);
      return { ok: true, event, idempotent: false, skipped: true };
    }

    event.attempts += 1;
    try {
      const result = await this.delivery.deliver(event, options.message);
      if (result.ok) {
        event.status = "delivered";
      } else {
        event.status = "failed";
        event.lastError = result.reason;
      }
    } catch (error) {
      // Provider threw: record, never propagate (signal creation unblocked).
      event.status = "failed";
      event.lastError =
        error instanceof Error ? error.message : "unknown delivery failure";
    }
    this.events.set(eventId, event);
    return { ok: true, event, idempotent: false, skipped: false };
  }
}

/** Process-wide alert center (single-user product; no-op provider). */
export const alertCenter = new AlertCenter();
