/**
 * Tiny-live pilot controls (P17-03, ADR-0031).
 *
 * The smallest possible live trading surface:
 * - Smallest permitted order size (a floor; orders below it are refused —
 *   no dust — and a ceiling; nothing bigger may ever be sent).
 * - Symbol allowlist (pilot subset of the demo universe).
 * - Session/time window restrictions (allowed trading days and an intraday
 *   UTC window; outside the window new entries are refused).
 * - Max orders per session (hard counter ceiling).
 * - Emergency stop (immediate, operator-triggered; append-only event).
 *
 * PILOT CONFIG MUST BE STRICTER THAN THE DEMO CONFIG: `assertPilotStricter`
 * fails closed when the pilot allows a bigger volume, more symbols, more
 * orders, or otherwise loosens any dimension the demo config constrains.
 *
 * No scaling based on a single winning streak (non-goal): order volume is
 * fixed by config; there is no performance-based size increase anywhere.
 * All timestamps UTC; deterministic for deterministic inputs; no broker
 * access from this module.
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";

export const LIVE_PILOT_ID = "live-pilot-controls";
export const LIVE_PILOT_VERSION = "1.0.0";

export class LivePilotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LivePilotError";
  }
}

// ---------------------------------------------------------------------------
// Pilot configuration
// ---------------------------------------------------------------------------

/** Days of the ISO week the pilot may trade (1=Mon .. 7=Sun). */
export const pilotTradingDaySchema = z.number().int().min(1).max(7);
export type PilotTradingDay = z.infer<typeof pilotTradingDaySchema>;

export const livePilotConfigSchema = z
  .object({
    /** Smallest permitted order volume, in units (floor AND the pilot size). */
    minOrderVolumeUnits: z.number().positive(),
    /** Largest permitted order volume, in units (ceiling). */
    maxOrderVolumeUnits: z.number().positive(),
    /** Pilot symbol allowlist (must be a subset of the demo allowlist). */
    allowedSymbols: z.array(z.string().min(1)).min(1),
    /** ISO weekdays (1..7) the pilot may open new entries. */
    tradingDays: z.array(pilotTradingDaySchema).min(1),
    /** Intraday UTC window (inclusive start, exclusive end), HH:MM. */
    sessionWindowStartUtc: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    sessionWindowEndUtc: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    /** Hard ceiling on accepted orders per pilot session. */
    maxOrdersPerSession: z.number().int().min(1),
    /** Max concurrent open positions (usually 1 for a tiny pilot). */
    maxConcurrentPositions: z.number().int().min(1),
    /** Emergency stop armed at creation: a pilot always ships with a stop. */
    emergencyStop: z.boolean(),
  })
  .strict()
  .refine((c) => c.maxOrderVolumeUnits >= c.minOrderVolumeUnits, {
    message: "maxOrderVolumeUnits must be >= minOrderVolumeUnits",
    path: ["maxOrderVolumeUnits"],
  })
  .refine((c) => c.emergencyStop === true, {
    message: "a pilot must be created with the emergency stop armed",
    path: ["emergencyStop"],
  })
  .refine(
    (c) => {
      // Overnight windows (start > end) are allowed (e.g. 22:00 -> 06:00);
      // equal window is rejected (empty window).
      return c.sessionWindowStartUtc !== c.sessionWindowEndUtc;
    },
    { message: "session window must be non-empty", path: ["sessionWindowStartUtc"] },
  );
export type LivePilotConfig = z.infer<typeof livePilotConfigSchema>;

// ---------------------------------------------------------------------------
// Strictness vs the demo configuration (acceptance criterion)
// ---------------------------------------------------------------------------

/** The demo-side dimensions a pilot must not loosen. */
export const demoComparisonSchema = z
  .object({
    maxOrderVolume: z.number().positive().optional(),
    allowedSymbols: z.array(z.string().min(1)).optional(),
    maxOrdersPerSession: z.number().int().min(1).optional(),
  })
  .strict();
export type DemoComparison = z.infer<typeof demoComparisonSchema>;

/**
 * Pilot must be stricter than the demo configuration on every constrained
 * dimension. Returns violations; empty array means stricter. Deterministic.
 */
export function pilotStrictnessViolations(
  pilot: LivePilotConfig,
  demo: DemoComparison,
): string[] {
  const p = livePilotConfigSchema.parse(pilot);
  const d = demoComparisonSchema.parse(demo);
  const violations: string[] = [];

  if (d.maxOrderVolume !== undefined && p.maxOrderVolumeUnits > d.maxOrderVolume) {
    violations.push(
      `pilot maxOrderVolumeUnits ${p.maxOrderVolumeUnits} exceeds demo maxOrderVolume ${d.maxOrderVolume}`,
    );
  }
  if (d.allowedSymbols !== undefined) {
    const demoSet = new Set(d.allowedSymbols);
    const outside = p.allowedSymbols.filter((s) => !demoSet.has(s));
    if (outside.length > 0) {
      violations.push(
        `pilot symbols outside demo allowlist: ${outside.sort().join(",")}`,
      );
    }
    if (p.allowedSymbols.length > d.allowedSymbols.length) {
      violations.push(
        `pilot allowlist has ${p.allowedSymbols.length} symbols, demo has ${d.allowedSymbols.length}`,
      );
    }
  }
  if (d.maxOrdersPerSession !== undefined && p.maxOrdersPerSession > d.maxOrdersPerSession) {
    violations.push(
      `pilot maxOrdersPerSession ${p.maxOrdersPerSession} exceeds demo ${d.maxOrdersPerSession}`,
    );
  }
  return violations;
}

/** Fail-closed strictness assertion (throws with every violation). */
export function assertPilotStricter(pilot: LivePilotConfig, demo: DemoComparison): void {
  const violations = pilotStrictnessViolations(pilot, demo);
  if (violations.length > 0) {
    throw new LivePilotError(
      `pilot configuration is not stricter than the demo configuration: ${violations.join("; ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Pilot session state machine (entry gate + emergency stop)
// ---------------------------------------------------------------------------

export const pilotEntryCheckSchema = z
  .object({
    symbol: z.string().min(1),
    volumeUnits: z.number().positive(),
    /** Instant the entry is attempted (UTC). */
    atUtc: utcInstantSchema,
    /** Current open positions count. */
    openPositions: z.number().int().min(0),
  })
  .strict();
export type PilotEntryCheck = z.infer<typeof pilotEntryCheckSchema>;

export const pilotEntryDecisionSchema = z
  .object({
    allowed: z.boolean(),
    reason: z.string().min(1),
  })
  .strict();
export type PilotEntryDecision = z.infer<typeof pilotEntryDecisionSchema>;

export const pilotEmergencyStopEventSchema = z
  .object({
    /** `lpstop_` + FNV-1a64 of canonical content. */
    eventId: z.string().regex(/^lpstop_[0-9a-f]{16}$/),
    stoppedBy: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
    reason: z.string().min(10).max(2000),
    stoppedAtUtc: utcInstantSchema,
    /** Exit-management path stays available (documented, never removed). */
    exitManagementPreserved: z.boolean(),
    /** Rollback never deletes state. */
    stateDeleted: z.literal(false),
  })
  .strict();
export type PilotEmergencyStopEvent = z.infer<typeof pilotEmergencyStopEventSchema>;

/**
 * Live pilot session: an entry gate evaluated per attempted entry plus an
 * emergency stop. Deterministic: no clock reads — every instant is input.
 */
export class LivePilotSession {
  private readonly config: LivePilotConfig;
  private ordersAccepted: number;
  private stopped: boolean;
  private stopEvent: PilotEmergencyStopEvent | null;
  private readonly sessionStartedAtUtc: string;

  constructor(config: LivePilotConfig, sessionStartedAtUtc: string) {
    this.config = livePilotConfigSchema.parse(config);
    this.sessionStartedAtUtc = utcInstantSchema.parse(sessionStartedAtUtc);
    this.ordersAccepted = 0;
    this.stopped = false;
    this.stopEvent = null;
  }

  get configSnapshot(): LivePilotConfig {
    return this.config;
  }

  get ordersAcceptedCount(): number {
    return this.ordersAccepted;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  get stopEventRecord(): PilotEmergencyStopEvent | null {
    return this.stopEvent;
  }

  /**
   * Emergency stop: immediately disables ALL new entries (idempotent — a
   * second stop is a no-op; the first event stays). Exit management is
   * explicitly preserved (documented on the event); nothing is deleted.
   */
  emergencyStop(stoppedBy: string, reason: string, stoppedAtUtc: string): PilotEmergencyStopEvent {
    if (this.stopped && this.stopEvent !== null) {
      return this.stopEvent; // idempotent: first event is the record
    }
    const core = {
      stoppedBy,
      reason,
      stoppedAtUtc,
      exitManagementPreserved: true,
      stateDeleted: false as const,
    };
    const eventId = `lpstop_${fnv1a64(`lpstop|${stoppedBy}|${reason}|${stoppedAtUtc}`)}`;
    const event = pilotEmergencyStopEventSchema.parse({ ...core, eventId });
    this.stopped = true;
    this.stopEvent = event;
    return event;
  }


  /**
   * Entry gate. Refuses (fail closed, with reason) when:
   * the session is stopped / volume is below the floor or above the ceiling /
   * the symbol is not allowlisted / the instant is not on a trading day /
   * the instant is outside the UTC session window / the order ceiling is
   * reached / the concurrency ceiling is reached. Accepts otherwise and
   * increments the accepted-order counter.
   */
  checkEntry(check: PilotEntryCheck): PilotEntryDecision {
    const c = pilotEntryCheckSchema.parse(check);
    if (this.stopped) {
      return { allowed: false, reason: "pilot is stopped (emergency stop engaged)" };
    }
    if (c.volumeUnits < this.config.minOrderVolumeUnits) {
      return {
        allowed: false,
        reason: `volume ${c.volumeUnits} is below the smallest permitted size ${this.config.minOrderVolumeUnits}`,
      };
    }
    if (c.volumeUnits > this.config.maxOrderVolumeUnits) {
      return {
        allowed: false,
        reason: `volume ${c.volumeUnits} exceeds the pilot ceiling ${this.config.maxOrderVolumeUnits}`,
      };
    }
    if (!this.config.allowedSymbols.includes(c.symbol)) {
      return { allowed: false, reason: `symbol '${c.symbol}' is not in the pilot allowlist` };
    }
    if (c.atUtc < this.sessionStartedAtUtc) {
      return {
        allowed: false,
        reason: `entry at ${c.atUtc} precedes the session start ${this.sessionStartedAtUtc}`,
      };
    }
    if (!isInSessionWindow(c.atUtc, this.config)) {
      return {
        allowed: false,
        reason: `entry at ${c.atUtc} is outside the pilot session window ${this.config.sessionWindowStartUtc}-${this.config.sessionWindowEndUtc} UTC`,
      };
    }
    if (this.ordersAccepted >= this.config.maxOrdersPerSession) {
      return {
        allowed: false,
        reason: `session order ceiling ${this.config.maxOrdersPerSession} reached`,
      };
    }
    if (c.openPositions >= this.config.maxConcurrentPositions) {
      return {
        allowed: false,
        reason: `concurrency ceiling ${this.config.maxConcurrentPositions} reached (${c.openPositions} open)`,
      };
    }
    this.ordersAccepted += 1;
    return {
      allowed: true,
      reason: `entry accepted (order ${this.ordersAccepted}/${this.config.maxOrdersPerSession})`,
    };
  }
}

// ---------------------------------------------------------------------------
// Session window helpers (UTC, deterministic)
// ---------------------------------------------------------------------------

/** Minutes since UTC midnight for an `HH:MM` string. */
function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((v) => Number.parseInt(v, 10));
  return h * 60 + m;
}

/**
 * True iff `atUtc` falls inside the config's trading days AND session
 * window. Overnight windows (start > end) wrap midnight. Deterministic.
 */
export function isInSessionWindow(atUtc: string, config: LivePilotConfig): boolean {
  const c = livePilotConfigSchema.parse(config);
  const d = new Date(Date.parse(atUtc));
  // ISO day: Mon=1..Sun=7 (getUTCDay: Sun=0..Sat=6).
  const isoDay = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  if (!c.tradingDays.includes(isoDay as PilotTradingDay)) {
    return false;
  }
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  const start = hhmmToMinutes(c.sessionWindowStartUtc);
  const end = hhmmToMinutes(c.sessionWindowEndUtc);
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end; // overnight wrap
}

/** FNV-1a64 hex (same primitive as obs/logging.ts). */
function fnv1a64(text: string): string {
  const mask = (1n << 64n) - 1n;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

