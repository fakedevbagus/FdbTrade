/**
 * Explicit runtime clock (M45, ADR-0034).
 *
 * The scheduler NEVER reads the wall clock directly: every time source is
 * injected as a `RuntimeClock`. Production uses `systemRuntimeClock`; tests,
 * replays, and the fixture soak use `ManualClock`, which advances only when
 * explicitly told to — so a simulated multi-hour soak is deterministic and
 * completes in milliseconds of wall time.
 *
 * UTC policy (ADR-0004) is preserved: ISO strings derived from the clock are
 * always UTC by construction.
 */

export interface RuntimeClock {
  /** Monotonic-with-the-era epoch milliseconds (UTC). */
  nowMs(): number;
}

/** Default production clock — the ONLY wall-clock read in the runtime. */
export const systemRuntimeClock: RuntimeClock = {
  nowMs: () => Date.now(),
};

/**
 * Deterministic manual clock. Starts at `startMs` (epoch ms) and moves ONLY
 * on `advance` / `set`. Used by tests and the fixture soak.
 */
export class ManualClock implements RuntimeClock {
  private currentMs: number;

  constructor(startMs: number = 0) {
    this.currentMs = startMs;
  }

  nowMs(): number {
    return this.currentMs;
  }

  /** Advance by a non-negative offset. */
  advance(ms: number): void {
    if (ms < 0) {
      throw new Error(`advance must be >= 0 ms: ${ms}`);
    }
    this.currentMs += ms;
  }

  /** Jump to an absolute epoch-ms instant (must not move backwards). */
  set(toMs: number): void {
    if (toMs < this.currentMs) {
      throw new Error(
        `clock must not move backwards: ${toMs} < ${this.currentMs}`,
      );
    }
    this.currentMs = toMs;
  }

  /** UTC ISO string for the current instant. */
  nowIso(): string {
    return new Date(this.currentMs).toISOString();
  }
}

/** UTC ISO rendering of an epoch-ms instant (pure helper). */
export function isoFromMs(epochMs: number): string {
  return new Date(epochMs).toISOString();
}
