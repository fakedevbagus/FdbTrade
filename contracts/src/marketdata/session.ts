/**
 * Session metadata contracts (P02-01).
 *
 * Sessions are metadata (constitution: "session semantics are
 * provider/instrument metadata, never hard-coded assumptions"). Schedules
 * live in `src/data/sessions.json`; this module defines the shape.
 *
 * Day-of-week is a lowercase string (`mon`..`sun`) — no JS/Python day-index
 * ambiguity. All times are UTC (ADR-0004). Weekends are excluded by
 * construction: a session day list never contains `sat`/`sun`.
 */
import { z } from "zod";

/** Canonical day-of-week tokens (Monday-first week). */
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const weekdaySchema = z.enum(WEEKDAYS);

/** `HH:MM` UTC — minutes precision, no seconds/offsets. */
export const hhmmSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM (UTC)");

/**
 * End-of-window time: `HH:MM` or the `24:00` sentinel (exclusive end at
 * UTC midnight of the NEXT day). Lets a weekday window cover the full day
 * (`00:00`–`24:00`) without special-casing.
 */
export const hhmmEndSchema = z.union([
  hhmmSchema,
  z.literal("24:00"),
]);

/** Named UTC offset windows in minutes (e.g. DST-sensitive session events later). */
export const sessionBreakSchema = z
  .object({
    /** Break start, `HH:MM` UTC. */
    startUtc: hhmmSchema,
    /** Break end (exclusive; `HH:MM` or `24:00`). */
    endUtc: hhmmEndSchema,
  })
  .strict();

export type SessionBreak = z.infer<typeof sessionBreakSchema>;

/**
 * One recurring weekly session window.
 *
 * `startUtc`/`endUtc` are wall-clock UTC times on `day`; windows may cross
 * midnight (end < start means rolls into the next calendar day).
 */
export const sessionWindowSchema = z
  .object({
    day: weekdaySchema,
    /** Window open time (UTC, HH:MM). */
    startUtc: hhmmSchema,
    /** Window close time (UTC, HH:MM or 24:00; exclusive; may roll past midnight). */
    endUtc: hhmmEndSchema,
    /** Optional intraday breaks (e.g. market close/reopen gaps). */
    breaks: z.array(sessionBreakSchema).default([]),
  })
  .strict();

export type SessionWindow = z.infer<typeof sessionWindowSchema>;

/** A named session schedule (e.g. `fx-24x5`). */
export const sessionScheduleSchema = z
  .object({
    id: z.string().min(1),
    /** Human description (no secrets). */
    description: z.string().min(1),
    /** Timezone all windows are defined in — locked to UTC (ADR-0004). */
    timezone: z.literal("UTC"),
    /** Weekly open windows; empty list = market never open (explicit). */
    windows: z.array(sessionWindowSchema),
    /** External reference for provenance (docs, not data). */
    sourceNote: z.string().min(0),
  })
  .strict();

export type SessionSchedule = z.infer<typeof sessionScheduleSchema>;

/** Session catalog file shape (sessions.json). */
export const sessionCatalogSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    updatedAtUtc: z.iso.datetime({ offset: false, precision: 3 }),
    schedules: z.array(sessionScheduleSchema).min(1),
  })
  .strict();

export type SessionCatalog = z.infer<typeof sessionCatalogSchema>;

/** Simple HH:MM -> minutes-since-midnight helper (UTC day); `24:00` -> 1440. */
export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

type DayToken = Weekday | "sat" | "sun";

const DAY_ORDER: readonly DayToken[] = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
];

/** Map a UTC date to its weekday token. */
export function toDayToken(d: Date): DayToken {
  // getUTCDay: 0=Sun..6=Sat — index into a Monday-first table.
  const idx = (d.getUTCDay() + 6) % 7;
  return DAY_ORDER[idx];
}

/** Previous CALENDAR day token (tue->mon, mon->sun, sun->sat). */
export function previousCalendarDay(day: DayToken): DayToken {
  const i = DAY_ORDER.indexOf(day);
  return DAY_ORDER[(i - 1 + DAY_ORDER.length) % DAY_ORDER.length];
}

/**
 * Whether a UTC instant falls inside a session window.
 *
 * Handles two end forms deterministically:
 * - `start <= end` (incl. `24:00`): same-day window `[start, end)`.
 * - `end < start`: window rolls past midnight — `[start, 24:00)` on its own
 *   day plus `[00:00, end)` on the NEXT calendar day (which may be sat/sun
 *   for a Friday roll; weekend days carry no windows of their own).
 */
export function isInstantInWindow(
  instant: string,
  window: SessionWindow,
): boolean {
  const d = new Date(instant);
  const dayToken = toDayToken(d);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();

  if (dayToken === window.day) {
    const start = hhmmToMinutes(window.startUtc);
    const end = hhmmToMinutes(window.endUtc); // "24:00" -> 1440
    if (start <= end) {
      return minutes >= start && minutes < end;
    }
    return minutes >= start; // rolls into the next day
  }

  // Tail of a rolling window that started on the previous calendar day.
  if (window.day === previousCalendarDay(dayToken)) {
    const start = hhmmToMinutes(window.startUtc);
    const end = hhmmToMinutes(window.endUtc);
    if (end < start) {
      return minutes < end;
    }
  }
  return false;
}

/**
 * Whether a UTC instant is inside ANY window of a schedule (breaks excluded).
 *
 * A break inside the containing window makes the instant closed. Breaks are
 * checked only against the window(s) that contain the instant.
 */
export function isInstantInSchedule(
  instant: string,
  schedule: SessionSchedule,
): boolean {
  const containing = schedule.windows.filter((w) =>
    isInstantInWindow(instant, w),
  );
  if (containing.length === 0) {
    return false;
  }
  const d = new Date(instant);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  for (const w of containing) {
    const inBreak = w.breaks.some((b) => {
      const bs = hhmmToMinutes(b.startUtc);
      const be = hhmmToMinutes(b.endUtc);
      // Break on the instant's own calendar morning (break start <= end).
      return bs <= be ? minutes >= bs && minutes < be : false;
    });
    if (inBreak) {
      return false;
    }
  }
  return true;
}


