/**
 * Risk gate <-> paper broker integration tests (P11-01 acceptance).
 *
 * Every paper order intent must pass through the independent risk service:
 * an order may leave the `intent` state ONLY with an approved decision for
 * ITS intent (assertRiskGateCleared -> intent -> risk_checked), and a
 * rejected decision forces the legal `intent -> rejected` transition with
 * the machine-readable `risk_rejected` reason. There is no bypass.
 */
import { describe, expect, it } from "vitest";

import {
  applyPaperOrderTransition,
  assertRiskGateCleared,
  evaluateRisk,
  paperOrderFromIntent,
  RiskBoundaryError,
  type BacktestOrderIntent,
  type RiskCheckRequest,
} from "@/index";

import { baseRequest, RISK_CONFIG } from "./risk-fixture";

const INTENT: BacktestOrderIntent = {
  intentId: "btord_sig_p11fixture_EURUSD_1h_long",
  signalId: "sig_p11fixture_EURUSD_1h_2026-09-08T10:00:00.000Z_long",
  strategyId: "trend-mtf-pullback",
  strategyVersion: "1.0.0",
  configVersion: "1.0.0",
  snapshotHash: "a".repeat(64),
  instrument: "EURUSD",
  timeframe: "1h",
  eventTimeUtc: "2026-09-08T10:00:00.000Z",
  direction: "long",
  entryType: "market",
  entryPrice: null,
  referencePrice: 1.1085,
  stopLoss: 1.1055,
  takeProfit: 1.1135,
  expiresAtUtc: "2026-09-08T14:00:00.000Z",
  quantityUnits: 10000,
};

const T_SUBMIT = "2026-09-08T10:00:00.000Z";
const T_RISK = "2026-09-08T10:00:01.000Z";

describe("paper/demo intents pass through the risk service (P11-01)", () => {
  it("moves an APPROVED order intent -> risk_checked -> submitting with the sized quantity", () => {
    const order = paperOrderFromIntent(INTENT, 1);
    expect(order.state).toBe("intent");

    const request: RiskCheckRequest = {
      ...baseRequest(),
      intentId: INTENT.intentId,
      signalId: INTENT.signalId,
      strategyId: INTENT.strategyId,
      strategyVersion: INTENT.strategyVersion,
      configVersion: INTENT.configVersion,
      snapshotHash: INTENT.snapshotHash,
      instrument: INTENT.instrument,
      timeframe: INTENT.timeframe,
      direction: INTENT.direction,
      entryType: INTENT.entryType,
      entryPrice: INTENT.entryPrice,
      referencePrice: INTENT.referencePrice,
      stopLoss: INTENT.stopLoss,
      takeProfit: INTENT.takeProfit,
      eventTimeUtc: INTENT.eventTimeUtc,
      expiresAtUtc: INTENT.expiresAtUtc,
      requestedQuantityUnits: INTENT.quantityUnits,
    };
    const decision = evaluateRisk(request, RISK_CONFIG);
    expect(decision.outcome).toBe("approved");

    // The ONLY path out of `intent` requires the cleared gate.
    expect(() => assertRiskGateCleared(order, decision)).not.toThrow();
    const riskChecked = applyPaperOrderTransition(order, "risk_checked", T_RISK);
    expect(riskChecked.state).toBe("risk_checked");
    const submitting = applyPaperOrderTransition(riskChecked, "submitting", T_RISK);
    expect(submitting.state).toBe("submitting");
  });

  it("forces a REJECTED order into `rejected` with the machine-readable risk reason", () => {
    const order = paperOrderFromIntent(INTENT, 1);
    const decision = evaluateRisk(
      { ...baseRequest(), requestedQuantityUnits: INTENT.quantityUnits, riskState: "kill" },
      RISK_CONFIG,
    );
    expect(decision.outcome).toBe("rejected");
    expect(() => assertRiskGateCleared(order, decision)).toThrow(RiskBoundaryError);
    // the legal fallback transition for a risk-denied intent
    const rejected = applyPaperOrderTransition(order, "rejected", T_RISK, "risk_rejected");
    expect(rejected.state).toBe("rejected");
    // terminal: no further submission possible
    expect(() => applyPaperOrderTransition(rejected, "submitting", T_RISK)).toThrow();
  });

  it("rejects bypassing the gate: another intent's approval cannot clear this order", () => {
    const order = paperOrderFromIntent({ ...INTENT, intentId: "btord_sig_other" }, 1);
    const decision = evaluateRisk(baseRequest(), RISK_CONFIG); // approved for a DIFFERENT intent
    expect(decision.outcome).toBe("approved");
    expect(() => assertRiskGateCleared(order, decision)).toThrow(RiskBoundaryError);
  });

  it("blocks the gate during KILL: the order can never leave `intent` as cleared", () => {
    const order = paperOrderFromIntent(INTENT, 1);
    const decision = evaluateRisk({ ...baseRequest(), riskState: "kill" }, RISK_CONFIG);
    expect(decision.outcome).toBe("rejected");
    expect(() => assertRiskGateCleared(order, decision)).toThrow(/risk_kill_engaged/);
  });

  it("blocks the gate on provider outage (fail closed, no new intents)", () => {
    const order = paperOrderFromIntent(INTENT, 1);
    const decision = evaluateRisk(
      { ...baseRequest(), market: { ...baseRequest().market, providerHealth: "outage" } },
      RISK_CONFIG,
    );
    expect(decision.outcome).toBe("rejected");
    expect(decision.reasons).toEqual(["risk_provider_unhealthy"]);
    expect(() => assertRiskGateCleared(order, decision)).toThrow(RiskBoundaryError);
  });

  it("the cleared decision carries the risk engine's FINAL (sized) quantity for the broker", () => {
    const request: RiskCheckRequest = {
      ...baseRequest(),
      requestedQuantityUnits: 500000, // oversized strategy proposal
    };
    const decision = evaluateRisk(request, RISK_CONFIG);
    expect(decision.sizeAdjusted).toBe(true);
    expect(decision.sizedQuantityUnits).toBe(166666.666667);
    expect(() => assertRiskGateCleared({ intentId: request.intentId }, decision)).not.toThrow();
  });
});
