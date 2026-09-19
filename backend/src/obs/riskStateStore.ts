/**
 * Process-wide latched risk-state store (P13-04).
 *
 * Wraps the P11 `RiskStateTracker` contract (ADR-0022): the state is latched
 * in-process; KILL is engaged/released ONLY by explicit human action
 * (never auto-reset), every override is audited (ADR-0025 ledger with
 * actor + before/after). The operator layer owns persistence — this store
 * is the P13 runtime surface until a durable store lands.
 */
import {
  applyRiskOverride,
  createRiskStateTracker,
  reduceRiskState,
  riskOverrideIdFor,
  type RiskOverride,
  type RiskState,
  type RiskStateTracker,
} from "@fdbtrade/contracts";


import { utcNowIso } from "@/clock";
import { auditService } from "@/obs/auditService";

export class RiskStateStore {
  private tracker: RiskStateTracker = createRiskStateTracker("green", "1970-01-01T00:00:00.000Z");

  /** Current latched state (read-only view). */
  get state(): RiskState {
    return this.tracker.state;
  }

  get lastChangedAtUtc(): string {
    return this.tracker.lastChangedAtUtc;
  }

  /**
   * Apply ONE human override (engage_kill / release_kill / force_state).
   * Every applied override is audited with actor + before/after. Invalid
   * moves (e.g. release_kill outside kill) throw from the P11 contract
   * before any state or audit change (fail closed).
   */
  applyOverride(
    override: Omit<RiskOverride, "overrideId" | "atUtc"> & { atUtc?: string },
  ): { from: RiskState; to: RiskState; overrideId: string } {
    const atUtc = override.atUtc ?? utcNowIso();
    const content = { ...override, atUtc };
    const from = this.tracker.state;
    const overrideId = riskOverrideIdFor(
      content.action,
      content.targetState,
      content.actor,
      content.reason,
      atUtc,
    );
    const to = applyRiskOverride(from, { ...content, overrideId });
    this.tracker = reduceRiskState(this.tracker, to, atUtc, overrideId);
    auditService.append({
      actor: content.actor,
      action: content.action,
      subjectType: "risk_override",
      subjectId: overrideId,
      before: { state: from },
      after: { state: to },
      correlationId: `riskstate-${overrideId}`,
      source: "risk-service",
      atUtc,
    });
    return { from, to, overrideId };
  }

  /** Reset (tests only). */
  resetForTest(): void {
    this.tracker = createRiskStateTracker("green", "1970-01-01T00:00:00.000Z");
  }
}

/** Process-wide singleton. */
const globalRiskState = globalThis as unknown as { __fdbRiskState?: RiskStateStore };
export const riskStateStore: RiskStateStore =
  globalRiskState.__fdbRiskState ?? (globalRiskState.__fdbRiskState = new RiskStateStore());
