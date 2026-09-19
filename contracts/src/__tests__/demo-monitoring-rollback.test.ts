/**
 * Tests for demo monitoring and rollback (P16-04, ADR-0030).
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_DEMO_MONITOR_THRESHOLDS,
  DemoExecutionMonitor,
  type DemoExecutionSample,
} from "../execution/monitoring";

function makeSample(overrides?: Partial<DemoExecutionSample>): DemoExecutionSample {
  return {
    clientOrderId: "dclo_s001",
    latencyMs: 100,
    rejected: false,
    errorCode: null,
    executionCostPct: 0.1,
    driftPct: 0.5,
    recordedAtUtc: "2026-09-12T12:00:00.000Z",
    ...overrides,
  };
}

describe("DemoExecutionMonitor (P16-04)", () => {
  it("computes empty snapshot with zero samples", () => {
    const m = new DemoExecutionMonitor({
      nowFn: () => "2026-09-12T12:00:00.000Z",
    });
    const snap = m.computeSnapshot();
    expect(snap.sampleCount).toBe(0);
    expect(snap.avgLatencyMs).toBe(0);
    expect(snap.rejectRatePct).toBe(0);
  });

  it("computes aggregate metrics from samples", () => {
    const m = new DemoExecutionMonitor({
      nowFn: () => "2026-09-12T12:00:00.000Z",
    });
    m.recordSample(makeSample({ latencyMs: 100, clientOrderId: "a" }));
    m.recordSample(makeSample({ latencyMs: 300, clientOrderId: "b" }));
    m.recordSample(makeSample({ latencyMs: 200, clientOrderId: "c" }));

    const snap = m.computeSnapshot();
    expect(snap.sampleCount).toBe(3);
    expect(snap.avgLatencyMs).toBeCloseTo(200, 6);
    expect(snap.maxLatencyMs).toBe(300);
  });

  it("does not disable below minimum sample size even with breaches", () => {
    const m = new DemoExecutionMonitor({
      thresholds: { minSampleSize: 10, maxLatencyMs: 100 },
      nowFn: () => "2026-09-12T12:00:00.000Z",
    });

    const r1 = m.recordSample(makeSample({ latencyMs: 5000, clientOrderId: "a" }));
    expect(r1.disabled).toBe(false);
    expect(m.isDisabled()).toBe(false);
  });

  it("auto-disables when latency threshold breached at min sample size", () => {
    const m = new DemoExecutionMonitor({
      thresholds: { minSampleSize: 3, maxLatencyMs: 1000 },
      nowFn: () => "2026-09-12T12:00:00.000Z",
    });

    m.recordSample(makeSample({ clientOrderId: "a" }));
    m.recordSample(makeSample({ clientOrderId: "b" }));
    const r3 = m.recordSample(makeSample({ clientOrderId: "c", latencyMs: 5000 }));

    expect(r3.disabled).toBe(true);
    expect(m.isDisabled()).toBe(true);
    expect(r3.event!.triggeredThreshold).toBe("maxLatencyMs");
    expect(r3.event!.observedValue).toBe(5000);
  });

  it("auto-disables when reject rate breached", () => {
    const m = new DemoExecutionMonitor({
      thresholds: { minSampleSize: 4, maxRejectRatePct: 50 },
      nowFn: () => "2026-09-12T12:00:00.000Z",
    });

    m.recordSample(makeSample({ clientOrderId: "a" }));
    m.recordSample(makeSample({ clientOrderId: "b", rejected: true }));
    m.recordSample(makeSample({ clientOrderId: "c", rejected: true }));
    const r4 = m.recordSample(makeSample({ clientOrderId: "d", rejected: true }));

    expect(r4.disabled).toBe(true);
    expect(r4.event!.triggeredThreshold).toBe("maxRejectRatePct");
    expect(r4.event!.observedValue).toBe(75); // 3/4 rejected
    expect(r4.disabled).toBe(true);
    expect(r4.event!.triggeredThreshold).toBe("maxRejectRatePct");
    expect(r4.event!.observedValue).toBe(75); // 3/4 rejected
  });

  it("auto-disables when error rate breached", () => {
    const m = new DemoExecutionMonitor({
      thresholds: { minSampleSize: 2, maxErrorRatePct: 50 },
      nowFn: () => "2026-09-12T12:00:00.000Z",
    });

    m.recordSample(makeSample({ clientOrderId: "a", errorCode: "E_TIMEOUT" }));
    const r2 = m.recordSample(makeSample({ clientOrderId: "b", errorCode: "E_NET" }));

    expect(r2.disabled).toBe(true);
    expect(r2.event!.triggeredThreshold).toBe("maxErrorRatePct");
  });

  it("auto-disables when drift breached", () => {
    const m = new DemoExecutionMonitor({
      thresholds: { minSampleSize: 2, maxDriftPct: 1 },
      nowFn: () => "2026-09-12T12:00:00.000Z",
    });

    m.recordSample(makeSample({ clientOrderId: "a", driftPct: 6 }));
    const r2 = m.recordSample(makeSample({ clientOrderId: "b" }));

    expect(r2.disabled).toBe(true);
    expect(r2.event!.triggeredThreshold).toBe("maxDriftPct");
  });

  it("auto-disables when execution cost breached", () => {
    const m = new DemoExecutionMonitor({
      thresholds: { minSampleSize: 2, maxExecutionCostPct: 0.5 },
      nowFn: () => "2026-09-12T12:00:00.000Z",
    });

    m.recordSample(makeSample({ clientOrderId: "a", executionCostPct: 0.8 }));
    const r2 = m.recordSample(makeSample({ clientOrderId: "b", executionCostPct: 0.7 }));

    expect(r2.disabled).toBe(true);
    expect(r2.event!.triggeredThreshold).toBe("maxExecutionCostPct");
  });

  it("rollback preserves state: disable never deletes orders/samples", () => {
    const m = new DemoExecutionMonitor({
      thresholds: { minSampleSize: 3, maxLatencyMs: 1000 },
      nowFn: () => "2026-09-12T12:00:00.000Z",
    });

    m.recordSample(makeSample({ clientOrderId: "a" }));
    m.recordSample(makeSample({ clientOrderId: "b" }));
    const r3 = m.recordSample(makeSample({ clientOrderId: "c", latencyMs: 5000 }));

    expect(r3.disabled).toBe(true);
    // State preserved:
    expect(r3.event!.stateDeleted).toBe(false);
    expect(r3.event!.ordersPreservedCount).toBe(3);
    expect(m.getSamples().length).toBe(3);
    expect(m.getSamples()[0].clientOrderId).toBe("a");
  });

  it("rejects malformed sample fail-closed", () => {
    const m = new DemoExecutionMonitor({
      nowFn: () => "2026-09-12T12:00:00.000Z",
    });
    expect(() =>
      m.recordSample({ ...makeSample(), latencyMs: -1 } as any),
    ).toThrow();
    expect(m.getSamples().length).toBe(0);
  });

  it("does not disable when all metrics within thresholds", () => {
    const m = new DemoExecutionMonitor({
      thresholds: { minSampleSize: 5 },
      nowFn: () => "2026-09-12T12:00:00.000Z",
    });

    for (let i = 0; i < 10; i += 1) {
      const r = m.recordSample(
        makeSample({ clientOrderId: `s${i}`, latencyMs: 50, executionCostPct: 0.05, driftPct: 0.1 }),
      );
      expect(r.disabled).toBe(false);
    }
    expect(m.isDisabled()).toBe(false);
  });

  it("default thresholds are conservative and valid", () => {
    expect(DEFAULT_DEMO_MONITOR_THRESHOLDS.minSampleSize).toBeGreaterThan(0);
    expect(DEFAULT_DEMO_MONITOR_THRESHOLDS.maxRejectRatePct).toBeLessThanOrEqual(100);
    expect(DEFAULT_DEMO_MONITOR_THRESHOLDS.maxErrorRatePct).toBeLessThanOrEqual(100);
  });
});
