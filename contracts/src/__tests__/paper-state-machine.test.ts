/**
 * Paper order state machine tests (P10-01).
 *
 * Acceptance: state transitions are explicit and illegal transitions are
 * rejected. All fixtures are deterministic (no randomness, no wall clock).
 */
import { describe, expect, it } from "vitest";

import {
  PAPER_ORDER_STATES,
  PAPER_ORDER_TRANSITIONS,
  PAPER_TERMINAL_STATES,
  PaperOrderStateError,
  applyPaperOrderTransition,
  canTransitionPaperOrder,
  paperOrderStateSchema,
  type PaperOrderState,
} from "@/index";

const T0 = "2026-09-08T10:00:00.000Z";

const HAPPY_PATH: PaperOrderState[] = [
  "intent",
  "risk_checked",
  "submitting",
  "acknowledged",
  "partially_filled",
  "filled",
  "managed",
  "closed",
];

describe("paper order state machine (P10-01)", () => {
  it("exposes the full frozen state vocabulary incl. rejected/expired/cancelled/error", () => {
    expect(PAPER_ORDER_STATES).toEqual([
      "intent",
      "risk_checked",
      "submitting",
      "acknowledged",
      "partially_filled",
      "filled",
      "managed",
      "closed",
      "rejected",
      "expired",
      "cancelled",
      "error",
    ]);
    expect(PAPER_TERMINAL_STATES).toEqual(["rejected", "expired", "cancelled", "error"]);
  });

  it("walks the full happy path intent -> ... -> closed", () => {
    let order: { orderId: string; state: PaperOrderState } = { orderId: "pbord_x", state: "intent" };
    for (let i = 1; i < HAPPY_PATH.length; i += 1) {
      expect(canTransitionPaperOrder(order.state, HAPPY_PATH[i]!)).toBe(true);
      order = applyPaperOrderTransition(order, HAPPY_PATH[i]!, T0);
    }
    expect(order.state).toBe("closed");
  });

  it("terminal states are absorbing (no outgoing transitions)", () => {
    for (const terminal of PAPER_TERMINAL_STATES) {
      expect(PAPER_ORDER_TRANSITIONS[terminal]).toEqual([]);
      for (const to of PAPER_ORDER_STATES) {
        expect(canTransitionPaperOrder(terminal, to)).toBe(false);
      }
    }
  });

  it("rejects illegal transitions explicitly (fail closed)", () => {
    const illegal: Array<[PaperOrderState, PaperOrderState]> = [
      ["intent", "acknowledged"],
      ["intent", "filled"],
      ["risk_checked", "acknowledged"],
      ["submitting", "filled"],
      ["acknowledged", "submitting"],
      ["filled", "partially_filled"],
      ["filled", "submitting"],
      ["managed", "filled"],
      ["closed", "managed"],
      ["rejected", "submitting"],
    ];
    for (const [from, to] of illegal) {
      expect(canTransitionPaperOrder(from, to)).toBe(false);
      expect(() => applyPaperOrderTransition({ orderId: "pbord_x", state: from }, to, T0)).toThrow(
        PaperOrderStateError,
      );
    }
  });

  it("allows filled -> managed without partials and working-order terminal exits", () => {
    expect(canTransitionPaperOrder("filled", "managed")).toBe(true);
    expect(canTransitionPaperOrder("acknowledged", "expired")).toBe(true);
    expect(canTransitionPaperOrder("acknowledged", "cancelled")).toBe(true);
    expect(canTransitionPaperOrder("partially_filled", "cancelled")).toBe(true);
    expect(canTransitionPaperOrder("partially_filled", "expired")).toBe(true);
    expect(canTransitionPaperOrder("submitting", "error")).toBe(true);
    expect(canTransitionPaperOrder("submitting", "rejected")).toBe(true);
    expect(canTransitionPaperOrder("intent", "rejected")).toBe(true);
  });

  it("malformed input fails closed (bad timestamp, empty reason, unknown state)", () => {
    expect(() =>
      applyPaperOrderTransition({ orderId: "pbord_x", state: "intent" }, "risk_checked", "not-a-time"),
    ).toThrow();
    expect(() =>
      applyPaperOrderTransition(
        { orderId: "pbord_x", state: "intent" },
        "risk_checked",
        T0,
        "",
      ),
    ).toThrow(PaperOrderStateError);
    expect(paperOrderStateSchema.safeParse("frobnicated").success).toBe(false);
    expect(paperOrderStateSchema.safeParse("managed").success).toBe(true);
  });

  it("is deterministic: identical inputs produce identical transitions", () => {
    const a = applyPaperOrderTransition({ orderId: "pbord_x", state: "intent" }, "risk_checked", T0);
    const b = applyPaperOrderTransition({ orderId: "pbord_x", state: "intent" }, "risk_checked", T0);
    expect(a).toEqual(b);
  });
});
