/**
 * Demo execution monitoring and rollback (P16-04, ADR-0030).
 *
 * Tracks execution metrics (latency, reject rate, drift, execution cost,
 * error rate) and implements automatic demo disable on critical thresholds.
 *
 * Rollback guarantee: disabling demo execution NEVER deletes orders or state;
 * the guard flips a boolean flag and records an audit trail entry, preserving
 * all ledger records, fill events and submission history.
 */
import { z } from "zod";

import { utcInstantSchema } from "../marketdata/time";

import { type DemoOrderExecutionResult } from "./contract";

// ---------------------------------------------------------------------------
// Metrics configuration
// ---------------------------------------------------------------------------

export const demoMonitorThresholdsSchema = z
  .object({
    maxLatencyMs: z.number().int().min(1),
    maxRejectRatePct: z.number().min(0).max(100),
    maxDriftPct: z.number().min(0),
    maxExecutionCostPct: z.number().min(0),
    maxErrorRatePct: z.number().min(0).max(100),
    minSampleSize: z.number().int().min(1).default(10),
  })
  .strict();

export type DemoMonitorThresholds = z.infer<typeof demoMonitorThresholdsSchema>;

export const DEFAULT_DEMO_MONITOR_THRESHOLDS: DemoMonitorThresholds = {
  maxLatencyMs: 2000,
  maxRejectRatePct: 30,
  maxDriftPct: 5,
  maxExecutionCostPct: 1,
  maxErrorRatePct: 20,
  minSampleSize: 10,
};

// ---------------------------------------------------------------------------
// Execution metric sample
// ---------------------------------------------------------------------------

export const demoExecutionSampleSchema = z
  .object({
    clientOrderId: z.string().min(1),
    latencyMs: z.number().min(0),
    rejected: z.boolean(),
    errorCode: z.string().nullable().default(null),
    executionCostPct: z.number().min(0),
    driftPct: z.number().min(0),
    recordedAtUtc: utcInstantSchema,
  })
  .strict();

export type DemoExecutionSample = z.infer<typeof demoExecutionSampleSchema>;

// ---------------------------------------------------------------------------
// Aggregated metrics snapshot
// ---------------------------------------------------------------------------

export const demoMetricsSnapshotSchema = z
  .object({
    sampleCount: z.number().int().min(0),
    avgLatencyMs: z.number().min(0),
    p95LatencyMs: z.number().min(0),
    maxLatencyMs: z.number().min(0),
    rejectRatePct: z.number().min(0).max(100),
    errorRatePct: z.number().min(0).max(100),
    avgExecutionCostPct: z.number().min(0),
    maxDriftPct: z.number().min(0),
    computedAtUtc: utcInstantSchema,
  })
  .strict();

export type DemoMetricsSnapshot = z.infer<typeof demoMetricsSnapshotSchema>;

// ---------------------------------------------------------------------------
// Rollback / disable event
// ---------------------------------------------------------------------------

export const demoDisableEventSchema = z
  .object({
    eventId: z.string().min(1),
    reason: z.string().min(1),
    triggeredThreshold: z.string().min(1),
    observedValue: z.number(),
    thresholdValue: z.number(),
    disabledAtUtc: utcInstantSchema,
    ordersPreservedCount: z.number().int().min(0),
    stateDeleted: z.literal(false),
  })
  .strict();

export type DemoDisableEvent = z.infer<typeof demoDisableEventSchema>;

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------

export class DemoExecutionMonitor {
  private readonly thresholds: DemoMonitorThresholds;
  private readonly samples: DemoExecutionSample[] = [];
  private disabled = false;
  private disableEvent: DemoDisableEvent | null = null;
  private readonly nowFn: () => string;
  private eventCounter = 0;

  constructor(options?: {
    thresholds?: Partial<DemoMonitorThresholds>;
    nowFn?: () => string;
  }) {
    this.thresholds = demoMonitorThresholdsSchema.parse({
      ...DEFAULT_DEMO_MONITOR_THRESHOLDS,
      ...options?.thresholds,
    });
    this.nowFn = options?.nowFn ?? (() => new Date().toISOString());
  }

  getThresholds(): DemoMonitorThresholds {
    return { ...this.thresholds };
  }

  isDisabled(): boolean {
    return this.disabled;
  }

  getDisableEvent(): DemoDisableEvent | null {
    return this.disableEvent;
  }

  /** Records one execution sample; evaluates thresholds after recording. */
  recordSample(sample: DemoExecutionSample): { disabled: boolean; event?: DemoDisableEvent } {
    const parsed = demoExecutionSampleSchema.parse(sample);
    this.samples.push(parsed);

    const snapshot = this.computeSnapshot();
    if (snapshot.sampleCount < this.thresholds.minSampleSize) {
      return { disabled: false };
    }

    const breach = this.evaluateThresholds(snapshot);
    if (breach) {
      this.eventCounter += 1;
      const event: DemoDisableEvent = {
        eventId: `dmon_${this.eventCounter}_${breach.threshold}`,
        reason: `demo execution auto-disabled: ${breach.threshold}=${breach.observed.toFixed(2)} exceeded threshold ${breach.limit}`,
        triggeredThreshold: breach.threshold,
        observedValue: breach.observed,
        thresholdValue: breach.limit,
        disabledAtUtc: this.nowFn(),
        ordersPreservedCount: this.samples.length,
        stateDeleted: false,
      };
      this.disabled = true;
      this.disableEvent = event;
      return { disabled: true, event };
    }

    return { disabled: false };
  }

  /** Computes aggregate metrics snapshot from recorded samples. */
  computeSnapshot(): DemoMetricsSnapshot {
    const count = this.samples.length;
    const nowUtc = this.nowFn();

    if (count === 0) {
      return {
        sampleCount: 0,
        avgLatencyMs: 0,
        p95LatencyMs: 0,
        maxLatencyMs: 0,
        rejectRatePct: 0,
        errorRatePct: 0,
        avgExecutionCostPct: 0,
        maxDriftPct: 0,
        computedAtUtc: nowUtc,
      };
    }

    const latencies = this.samples.map((s) => s.latencyMs).sort((a, b) => a - b);
    const avgLatency = latencies.reduce((s, v) => s + v, 0) / count;
    const p95Idx = Math.min(count - 1, Math.max(0, Math.floor(0.95 * count) - 1));
    const p95Latency = latencies[p95Idx] ?? 0;
    const maxLatency = latencies[count - 1] ?? 0;

    const rejectedCount = this.samples.filter((s) => s.rejected).length;
    const rejectRatePct = (rejectedCount / count) * 100;

    const errorCount = this.samples.filter((s) => s.errorCode !== null).length;
    const errorRatePct = (errorCount / count) * 100;

    const avgCost =
      this.samples.reduce((s, v) => s + v.executionCostPct, 0) / count;
    const maxDrift = Math.max(...this.samples.map((s) => s.driftPct));

    return {
      sampleCount: count,
      avgLatencyMs: avgLatency,
      p95LatencyMs: p95Latency,
      maxLatencyMs: maxLatency,
      rejectRatePct,
      errorRatePct,
      avgExecutionCostPct: avgCost,
      maxDriftPct: maxDrift,
      computedAtUtc: nowUtc,
    };
  }

  /** Returns first threshold breach, or null if all within limits. */
  private evaluateThresholds(
    snapshot: DemoMetricsSnapshot,
  ): { threshold: string; observed: number; limit: number } | null {
    if (snapshot.maxLatencyMs > this.thresholds.maxLatencyMs) {
      return {
        threshold: "maxLatencyMs",
        observed: snapshot.maxLatencyMs,
        limit: this.thresholds.maxLatencyMs,
      };
    }
    if (snapshot.rejectRatePct > this.thresholds.maxRejectRatePct) {
      return {
        threshold: "maxRejectRatePct",
        observed: snapshot.rejectRatePct,
        limit: this.thresholds.maxRejectRatePct,
      };
    }
    if (snapshot.maxDriftPct > this.thresholds.maxDriftPct) {
      return {
        threshold: "maxDriftPct",
        observed: snapshot.maxDriftPct,
        limit: this.thresholds.maxDriftPct,
      };
    }
    if (snapshot.avgExecutionCostPct > this.thresholds.maxExecutionCostPct) {
      return {
        threshold: "maxExecutionCostPct",
        observed: snapshot.avgExecutionCostPct,
        limit: this.thresholds.maxExecutionCostPct,
      };
    }
    if (snapshot.errorRatePct > this.thresholds.maxErrorRatePct) {
      return {
        threshold: "maxErrorRatePct",
        observed: snapshot.errorRatePct,
        limit: this.thresholds.maxErrorRatePct,
      };
    }
    return null;
  }

  /** All recorded samples (rollback: state preserved, never deleted). */
  getSamples(): DemoExecutionSample[] {
    return [...this.samples];
  }
}
