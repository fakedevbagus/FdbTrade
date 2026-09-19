/**
 * Partial fills, rejects, timeouts and asynchronous status reconciliation
 * for demo execution (P16-03, ADR-0030).
 *
 * Guarantees:
 * 1. Every terminal state (filled, rejected, cancelled, expired) is reachable
 *    and reconciled against the broker's read-only state.
 * 2. Timeout / unknown outcomes NEVER assume an outcome: they enter an explicit
 *    `investigation` state until reconciled by an async broker status query.
 * 3. Partial fills accumulate fill events until terminal.
 * 4. All timestamps UTC (ADR-0004). Deterministic for deterministic inputs.
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";

import {
  type DemoOrderExecutionResult,
  type DemoOrderIntent,
  type DemoOrderStatus,
  demoOrderSideSchema,
  demoOrderTypeSchema,
} from "./contract";

// ---------------------------------------------------------------------------
// Fill event
// ---------------------------------------------------------------------------

export const demoFillEventSchema = z
  .object({
    fillId: z.string().min(1),
    clientOrderId: z.string().min(1),
    brokerTicket: z.string().min(1),
    filledUnits: z.number().positive(),
    price: z.number().positive(),
    commission: z.number().min(0).default(0),
    filledAtUtc: utcInstantSchema,
  })
  .strict();

export type DemoFillEvent = z.infer<typeof demoFillEventSchema>;

// ---------------------------------------------------------------------------
// Broker status report (raw async update)
// ---------------------------------------------------------------------------

export const demoBrokerStatusReportSchema = z
  .object({
    clientOrderId: z.string().min(1),
    brokerTicket: z.string().nullable(),
    status: z.enum([
      "submitted",
      "acknowledged",
      "partially_filled",
      "filled",
      "rejected",
      "cancelled",
      "expired",
      "unknown",
    ]),
    filledUnits: z.number().min(0),
    averagePrice: z.number().positive().nullable(),
    rejectReason: z.string().nullable().optional(),
    reportedAtUtc: utcInstantSchema,
  })
  .strict();

export type DemoBrokerStatusReport = z.infer<typeof demoBrokerStatusReportSchema>;

// ---------------------------------------------------------------------------
// Reconciliation outcome
// ---------------------------------------------------------------------------

export type DemoReconciliationOutcome =
  | { kind: "terminal"; status: Extract<DemoOrderStatus, "filled" | "rejected" | "cancelled" | "expired">; reconciled: true }
  | { kind: "in_progress"; status: "submitted" | "acknowledged" | "partially_filled"; reconciled: false }
  | { kind: "investigation"; status: "investigation"; reconciled: false; reason: string };

// ---------------------------------------------------------------------------
// Timeout configuration
// ---------------------------------------------------------------------------

export const demoTimeoutConfigSchema = z
  .object({
    ackTimeoutMs: z.number().int().min(1),
    fillTimeoutMs: z.number().int().min(1),
  })
  .strict();

export type DemoTimeoutConfig = z.infer<typeof demoTimeoutConfigSchema>;

export const DEFAULT_DEMO_TIMEOUTS: DemoTimeoutConfig = {
  ackTimeoutMs: 5000,
  fillTimeoutMs: 30000,
};

// ---------------------------------------------------------------------------
// Partial fill accumulator
// ---------------------------------------------------------------------------

export class DemoFillAccumulator {
  private readonly fills: DemoFillEvent[] = [];

  constructor(private readonly volumeRequested: number) {}

  addFill(fill: DemoFillEvent): void {
    const parsed = demoFillEventSchema.parse(fill);
    this.fills.push(parsed);
    this.fills.sort((a, b) => a.filledAtUtc.localeCompare(b.filledAtUtc));
  }

  totalFilledUnits(): number {
    return this.fills.reduce((sum, f) => sum + f.filledUnits, 0);
  }

  remainingUnits(): number {
    return Math.max(0, this.volumeRequested - this.totalFilledUnits());
  }

  isFullyFilled(): boolean {
    return this.totalFilledUnits() >= this.volumeRequested;
  }

  isPartiallyFilled(): boolean {
    const filled = this.totalFilledUnits();
    return filled > 0 && filled < this.volumeRequested;
  }

  averagePrice(): number | null {
    if (this.fills.length === 0) return null;
    const totalUnits = this.totalFilledUnits();
    if (totalUnits <= 0) return null;
    const weighted = this.fills.reduce(
      (sum, f) => sum + f.filledUnits * f.price,
      0,
    );
    return weighted / totalUnits;
  }

  totalCommission(): number {
    return this.fills.reduce((sum, f) => sum + (f.commission ?? 0), 0);
  }

  fillCount(): number {
    return this.fills.length;
  }

  assertNoOverfill(): void {
    if (this.totalFilledUnits() > this.volumeRequested) {
      throw new Error(
        `Overfill detected: filled ${this.totalFilledUnits()} exceeds requested ${this.volumeRequested}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Status reconciler (timeout / unknown -> investigation)
// ---------------------------------------------------------------------------

export class DemoStatusReconciler {
  private readonly timeouts: DemoTimeoutConfig;

  constructor(timeouts?: Partial<DemoTimeoutConfig>) {
    this.timeouts = demoTimeoutConfigSchema.parse({
      ackTimeoutMs: timeouts?.ackTimeoutMs ?? DEFAULT_DEMO_TIMEOUTS.ackTimeoutMs,
      fillTimeoutMs: timeouts?.fillTimeoutMs ?? DEFAULT_DEMO_TIMEOUTS.fillTimeoutMs,
    });
  }

  /**
   * Reconcile a raw broker status report against the tracked order state.
   * Unknown/timeout reports enter `investigation`, never assume an outcome.
   */
  reconcile(
    lastResult: DemoOrderExecutionResult,
    report: DemoBrokerStatusReport,
    nowUtc: string,
  ): DemoReconciliationOutcome {
    const validated = demoBrokerStatusReportSchema.parse(report);

    const submittedMs = Date.parse(lastResult.submittedAtUtc);
    const nowMs = Date.parse(nowUtc);
    if (!Number.isFinite(submittedMs) || !Number.isFinite(nowMs)) {
      return {
        kind: "investigation",
        status: "investigation",
        reconciled: false,
        reason: "invalid timestamps",
      };
    }
    const elapsedMs = nowMs - submittedMs;

    switch (validated.status) {
      case "filled":
      case "rejected":
      case "cancelled":
      case "expired":
        return { kind: "terminal", status: validated.status, reconciled: true };

      case "partially_filled":
      case "acknowledged":
      case "submitted":
        if (elapsedMs > this.timeouts.fillTimeoutMs) {
          return {
            kind: "investigation",
            status: "investigation",
            reconciled: false,
            reason: `fill timeout after ${elapsedMs}ms exceeds ${this.timeouts.fillTimeoutMs}ms; outcome unknown`,
          };
        }
        return {
          kind: "in_progress",
          status: validated.status,
          reconciled: false,
        };

      case "unknown":
      default:
        return {
          kind: "investigation",
          status: "investigation",
          reconciled: false,
          reason:
            validated.rejectReason ??
            `broker reported unknown status for ticket ${validated.brokerTicket ?? "null"}`,
        };
    }
  }

  /**
   * Apply a reconciliation outcome to a tracked result, producing the next
   * result state. Terminal states are absorbing.
   */
  applyOutcome(
    lastResult: DemoOrderExecutionResult,
    outcome: DemoReconciliationOutcome,
    report: DemoBrokerStatusReport,
    nowUtc: string,
  ): DemoOrderExecutionResult {
    // Terminal states are absorbing: never overwrite a terminal result.
    if (
      lastResult.status === "filled" ||
      lastResult.status === "rejected" ||
      lastResult.status === "cancelled" ||
      lastResult.status === "expired"
    ) {
      return lastResult;
    }

    if (outcome.kind === "investigation") {
      return {
        ...lastResult,
        status: "investigation",
        rejectReason: outcome.reason,
        updatedAtUtc: nowUtc,
      };
    }

    if (outcome.kind === "in_progress") {
      const filled = report.filledUnits;
      const remaining = Math.max(0, lastResult.volumeRequested - filled);
      return {
        ...lastResult,
        status: report.filledUnits > 0 ? "partially_filled" : outcome.status,
        volumeFilled: filled,
        remainingUnits: remaining,
        averagePrice: report.averagePrice ?? lastResult.averagePrice,
        brokerTicket: report.brokerTicket ?? lastResult.brokerTicket,
        updatedAtUtc: nowUtc,
      };
    }

    // terminal
    const filled = report.filledUnits;
    const remaining = Math.max(0, lastResult.volumeRequested - filled);
    return {
      ...lastResult,
      status: outcome.status,
      volumeFilled: filled,
      remainingUnits: remaining,
      averagePrice: report.averagePrice ?? lastResult.averagePrice,
      rejectReason: report.rejectReason ?? null,
      brokerTicket: report.brokerTicket ?? lastResult.brokerTicket,
      updatedAtUtc: nowUtc,
    };
  }
}

