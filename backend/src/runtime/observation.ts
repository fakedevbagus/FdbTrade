/**
 * Production cycle observation (M45, ADR-0034).
 *
 * The real work the runtime scheduler performs per stage: a structured,
 * redacted observation written to the bounded runtime log under the cycle's
 * correlation id, returning a deterministic digest.
 *
 * HARD SAFETY BOUNDARY: this module must never import, call, or reference
 * any order path, gateway adapter, or execution service. It observes and
 * records; that is all. `make runtime-check` greps this file for forbidden
 * order-vocabulary tokens to keep the boundary honest.
 */

import type { BoundedRuntimeLog } from "./retention";
import type { RuntimeClock } from "./clock";
import { createHash } from "node:crypto";

export interface RuntimeObservation {
  observe(cycleId: string, correlationId: string, stage: string): Promise<string>;
}

/** Deterministic digest for one stage observation. */
export function observationDigest(cycleId: string, stage: string): string {
  return createHash("sha256")
    .update(`observation|${cycleId}|${stage}`)
    .digest("hex")
    .slice(0, 16);
}

export function createRuntimeObservation(
  log: BoundedRuntimeLog,
  clock: RuntimeClock,
): RuntimeObservation {
  return {
    async observe(cycleId, correlationId, stage) {
      log.append({
        atMs: clock.nowMs(),
        correlationId,
        cycleId,
        level: "info",
        event: "stage_observed",
        detail: `stage=${stage}`,
      });
      return observationDigest(cycleId, stage);
    },
  };
}
