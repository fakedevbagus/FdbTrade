/**
 * Tests for partial fills, rejects, timeouts (P16-03, ADR-0030).
 */
import { describe, expect, it } from "vitest";

import {
  DemoFillAccumulator,
  DemoStatusReconciler,
  type DemoFillEvent,
  type DemoBrokerStatusReport,
} from "../execution/fills";
import type { DemoOrderExecutionResult } from "../execution/contract";

function baseResult(overrides?: Partial<DemoOrderExecutionResult>): DemoOrderExecutionResult {
  return {
    clientOrderId: "dclo_test001",
    intentId: "intent_001",
    brokerTicket: "ticket_001",
    symbol: "EURUSD",
    side: "buy",
    orderType: "market",
    status: "acknowledged",
    volumeRequested: 10000,
    volumeFilled: 0,
    remainingUnits: 10000,
    averagePrice: null,
    rejectReason: null,
    submittedAtUtc: "2026-09-12T12:00:00.000Z",
    updatedAtUtc: "2026-09-12T12:00:00.000Z",
    ...overrides,
  };
}

function makeFill(overrides?: Partial<DemoFillEvent>): DemoFillEvent {
  return {
    fillId: "fill_001",
    clientOrderId: "dclo_test001",
    brokerTicket: "ticket_001",
    filledUnits: 5000,
    price: 1.0855,
    commission: 0.5,
    filledAtUtc: "2026-09-12T12:00:01.000Z",
    ...overrides,
  };
}

describe("DemoFillAccumulator (P16-03)", () => {
  it("accumulates partial fills and computes VWAP", () => {
    const acc = new DemoFillAccumulator(10000);
    acc.addFill(makeFill({ fillId: "f1", filledUnits: 4000, price: 1.085 }));
    acc.addFill(makeFill({ fillId: "f2", filledUnits: 6000, price: 1.086 }));

    expect(acc.totalFilledUnits()).toBe(10000);
    expect(acc.remainingUnits()).toBe(0);
    expect(acc.isFullyFilled()).toBe(true);
    expect(acc.isPartiallyFilled()).toBe(false);
    expect(acc.fillCount()).toBe(2);

    const vwap = acc.averagePrice()!;
    expect(vwap).toBeCloseTo((4000 * 1.085 + 6000 * 1.086) / 10000, 6);
  });

  it("tracks partially filled state correctly", () => {
    const acc = new DemoFillAccumulator(10000);
    acc.addFill(makeFill({ filledUnits: 3000, price: 1.085 }));

    expect(acc.isPartiallyFilled()).toBe(true);
    expect(acc.isFullyFilled()).toBe(false);
    expect(acc.remainingUnits()).toBe(7000);
  });

  it("returns null average price with no fills", () => {
    const acc = new DemoFillAccumulator(10000);
    expect(acc.averagePrice()).toBeNull();
    expect(acc.totalFilledUnits()).toBe(0);
  });

  it("detects overfill and throws", () => {
    const acc = new DemoFillAccumulator(5000);
    acc.addFill(makeFill({ fillId: "f1", filledUnits: 3000 }));
    acc.addFill(makeFill({ fillId: "f2", filledUnits: 3000 }));

    expect(() => acc.assertNoOverfill()).toThrow(/Overfill/);
  });

  it("rejects malformed fill event", () => {
    const acc = new DemoFillAccumulator(10000);
    expect(() =>
      acc.addFill({ ...makeFill(), fillId: "" } as any),
    ).toThrow();
  });
});

describe("DemoStatusReconciler (P16-03)", () => {
  function makeReport(overrides?: Partial<DemoBrokerStatusReport>): DemoBrokerStatusReport {
    return {
      clientOrderId: "dclo_test001",
      brokerTicket: "ticket_001",
      status: "filled",
      filledUnits: 10000,
      averagePrice: 1.0855,
      reportedAtUtc: "2026-09-12T12:00:01.000Z",
      ...overrides,
    };
  }

  it("reconciles terminal filled report", () => {
    const r = new DemoStatusReconciler();
    const outcome = r.reconcile(baseResult(), makeReport(), "2026-09-12T12:00:01.000Z");
    expect(outcome.kind).toBe("terminal");
    expect(outcome.status).toBe("filled");
  });

  it("reconciles terminal rejected report with reason", () => {
    const r = new DemoStatusReconciler();
    const outcome = r.reconcile(
      baseResult(),
      makeReport({ status: "rejected", filledUnits: 0, averagePrice: null, rejectReason: "insufficient_margin" }),
      "2026-09-12T12:00:01.000Z",
    );
    expect(outcome.kind).toBe("terminal");
    expect(outcome.status).toBe("rejected");
  });

  it("keeps in-progress partial fills as in_progress (within timeout)", () => {
    const r = new DemoStatusReconciler();
    const outcome = r.reconcile(
      baseResult(),
      makeReport({ status: "partially_filled", filledUnits: 4000 }),
      "2026-09-12T12:00:05.000Z",
    );
    expect(outcome.kind).toBe("in_progress");
    expect(outcome.status).toBe("partially_filled");
  });

  it("moves to investigation on fill timeout (unknown outcome never assumed)", () => {
    const r = new DemoStatusReconciler({ fillTimeoutMs: 5000 });
    const outcome = r.reconcile(
      baseResult(),
      makeReport({ status: "partially_filled", filledUnits: 4000 }),
      "2026-09-12T12:01:00.000Z", // 60s after submission
    );
    expect(outcome.kind).toBe("investigation");
    expect(outcome.status).toBe("investigation");
    expect(outcome.reconciled).toBe(false);
  });

  it("moves unknown status to investigation with reason", () => {
    const r = new DemoStatusReconciler();
    const outcome = r.reconcile(
      baseResult(),
      makeReport({ status: "unknown", filledUnits: 0, brokerTicket: null }),
      "2026-09-12T12:00:02.000Z",
    );
    expect(outcome.kind).toBe("investigation");
  });

  it("rejects malformed report (fail-closed)", () => {
    const r = new DemoStatusReconciler();
    const bad = { ...makeReport(), status: "garbage" } as any;
    expect(() => r.reconcile(baseResult(), bad, "2026-09-12T12:00:01.000Z")).toThrow();
  });

  it("investigation on invalid timestamps", () => {
    const r = new DemoStatusReconciler();
    const outcome = r.reconcile(
      baseResult(),
      makeReport(),
      "not-a-timestamp",
    );
    expect(outcome.kind).toBe("investigation");
    expect(outcome.reconciled).toBe(false);
  });
});

describe("DemoStatusReconciler.applyOutcome (P16-03)", () => {
  function makeReport(overrides?: Partial<DemoBrokerStatusReport>): DemoBrokerStatusReport {
    return {
      clientOrderId: "dclo_test001",
      brokerTicket: "ticket_001",
      status: "filled",
      filledUnits: 10000,
      averagePrice: 1.0855,
      reportedAtUtc: "2026-09-12T12:00:01.000Z",
      ...overrides,
    };
  }

  it("applies in-progress outcome to tracked result", () => {
    const r = new DemoStatusReconciler();
    const outcome = r.reconcile(
      baseResult(),
      makeReport({ status: "partially_filled", filledUnits: 4000, averagePrice: 1.085 }),
      "2026-09-12T12:00:02.000Z",
    );
    const next = r.applyOutcome(baseResult(), outcome, makeReport({ status: "partially_filled", filledUnits: 4000, averagePrice: 1.085 }), "2026-09-12T12:00:02.000Z");

    expect(next.status).toBe("partially_filled");
    expect(next.volumeFilled).toBe(4000);
    expect(next.remainingUnits).toBe(6000);
  });

  it("applies terminal outcome", () => {
    const r = new DemoStatusReconciler();
    const outcome = r.reconcile(baseResult(), makeReport(), "2026-09-12T12:00:02.000Z");
    const next = r.applyOutcome(baseResult(), outcome, makeReport(), "2026-09-12T12:00:02.000Z");

    expect(next.status).toBe("filled");
    expect(next.volumeFilled).toBe(10000);
    expect(next.remainingUnits).toBe(0);
  });

  it("terminal states are absorbing (never overwritten)", () => {
    const r = new DemoStatusReconciler();
    const terminal = baseResult({ status: "filled", volumeFilled: 10000, remainingUnits: 0 });
    const outcome = r.reconcile(terminal, makeReport({ status: "rejected" }), "2026-09-12T12:00:05.000Z");
    const next = r.applyOutcome(terminal, outcome, makeReport({ status: "rejected" }), "2026-09-12T12:00:05.000Z");

    expect(next.status).toBe("filled"); // absorbing
    expect(next).toBe(terminal);
  });

  it("applies investigation outcome with reason", () => {
    const r = new DemoStatusReconciler({ fillTimeoutMs: 1000 });
    const outcome = r.reconcile(
      baseResult(),
      makeReport({ status: "unknown", filledUnits: 0 }),
      "2026-09-12T12:00:05.000Z",
    );
    const next = r.applyOutcome(
      baseResult(),
      outcome,
      makeReport({ status: "unknown", filledUnits: 0 }),
      "2026-09-12T12:00:05.000Z",
    );

    expect(next.status).toBe("investigation");
    expect(next.rejectReason).toBeTruthy();
  });
});

