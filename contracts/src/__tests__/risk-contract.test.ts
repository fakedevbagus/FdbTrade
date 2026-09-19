/**
 * Independent risk service boundary tests (P11-01).
 *
 * Acceptance: every paper/demo order intent passes through the risk service;
 * malformed input fails closed; the decision is content-addressed and
 * idempotent. Deterministic fixtures only (no randomness, no wall clock).
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RISK_LIMITS,
  RISK_ENGINE_ID,
  RISK_ENGINE_VERSION,
  RISK_REJECT_REASONS,
  RiskBoundaryError,
  assertRiskGateCleared,
  evaluateRisk,
  riskHash16,
  riskRequestDigestFor,
  riskDecisionIdFor,
  serializeRiskDecisionCanonical,
  serializeRiskRequestCanonical,
  type RiskCheckRequest,
  type RiskDecision,
} from "@/index";

import { baseRequest } from "./risk-fixture";

describe("risk service boundary (P11-01)", () => {
  it("approves a valid request with the engine identity and positive final size", () => {
    const decision = evaluateRisk(baseRequest(), DEFAULT_RISK_LIMITS);
    expect(decision.outcome).toBe("approved");
    expect(decision.reasons).toEqual([]);
    expect(decision.riskEngineId).toBe(RISK_ENGINE_ID);
    expect(decision.riskEngineVersion).toBe(RISK_ENGINE_VERSION);
    expect(decision.sizedQuantityUnits).toBe(10000); // requested below the risk-sized cap
    expect(decision.sizeAdjusted).toBe(false);
    expect(decision.riskAmountAccount).toBe(30); // 10000 x 0.0030 stop distance x rate 1
    expect(decision.riskState).toBe("green");
  });

  it("is idempotent: the same request/config produces the same content-addressed decision", () => {
    const a = evaluateRisk(baseRequest(), DEFAULT_RISK_LIMITS);
    const b = evaluateRisk(baseRequest(), DEFAULT_RISK_LIMITS);
    expect(b).toEqual(a);
    expect(a.decisionId).toMatch(/^riskdec_[0-9a-f]{16}$/);
  });

  it("records the exact input snapshot digest with the decision", () => {
    const decision = evaluateRisk(baseRequest(), DEFAULT_RISK_LIMITS);
    expect(decision.requestDigest).toBe(riskRequestDigestFor(baseRequest()));
    expect(decision.requestDigest).toBe(
      riskHash16(serializeRiskRequestCanonical(baseRequest())),
    );
  });

  it("rejects a different request deterministically (different checkedAtUtc -> different id)", () => {
    const a = evaluateRisk(baseRequest(), DEFAULT_RISK_LIMITS);
    const b = evaluateRisk(
      baseRequest({ checkedAtUtc: "2026-09-08T10:05:00.000Z" }),
      DEFAULT_RISK_LIMITS,
    );
    expect(b.decisionId).not.toBe(a.decisionId);
    expect(b.outcome).toBe("approved");
  });

  it("decision id hashes the canonical decision content (no id laundering)", () => {
    const a = evaluateRisk(baseRequest(), DEFAULT_RISK_LIMITS);
    const full = serializeRiskDecisionCanonical(a);
    const content = full.slice(0, full.length - (a.decisionId.length + 1));
    expect(a.decisionId).toBe(riskDecisionIdFor(content));
  });

  it("fails closed on malformed input: missing checkedAtUtc", () => {
    const bad = { ...baseRequest() } as Record<string, unknown>;
    delete bad.checkedAtUtc;
    expect(() => evaluateRisk(bad as unknown as RiskCheckRequest, DEFAULT_RISK_LIMITS)).toThrow(
      /malformed risk check input/,
    );
  });

  it("fails closed on malformed input: non-UTC timestamp is rejected at the boundary", () => {
    const bad = baseRequest();
    bad.market.conversion.rateAtUtc = "2026-09-08T09:00:00+02:00" as never;
    expect(() => evaluateRisk(bad, DEFAULT_RISK_LIMITS)).toThrow(/malformed risk check input/);
  });

  it("fails closed on direction-inconsistent levels (long with stop above entry)", () => {
    const bad = baseRequest({ stopLoss: 1.2 });
    expect(() => evaluateRisk(bad, DEFAULT_RISK_LIMITS)).toThrow(/malformed risk check input/);
  });

  it("fails closed on duplicate open-position ids", () => {
    const dup = {
      positionId: "pbpos_dup",
      instrument: "EURUSD",
      direction: "long",
      quantityUnits: 1000,
      avgPrice: 1.108,
      stopLoss: 1.105,
      openedAtUtc: "2026-09-08T08:00:00.000Z",
      strategyId: "trend-mtf-pullback",
      conversion: {
        quoteCurrency: "USD",
        accountCurrency: "USD",
        conversionRate: 1,
        rateAtUtc: "2026-09-08T08:00:00.000Z",
        rateSource: "fixture",
      },
    } as const;
    const bad = baseRequest({ openPositions: [dup, { ...dup }] });
    expect(() => evaluateRisk(bad, DEFAULT_RISK_LIMITS)).toThrow(/malformed risk check input/);
  });

  it("fails closed when the market snapshot does not match the entry instrument", () => {
    const bad = baseRequest();
    bad.market.instrument = "GBPUSD";
    expect(() => evaluateRisk(bad, DEFAULT_RISK_LIMITS)).toThrow(/malformed risk check input/);
  });

  it("freezes the rejection-reason vocabulary", () => {
    expect(RISK_REJECT_REASONS).toEqual([
      "risk_kill_engaged",
      "risk_state_orange",
      "risk_state_red",
      "risk_data_stale",
      "risk_provider_unhealthy",
      "risk_daily_loss_stop",
      "risk_weekly_drawdown_stop",
      "risk_max_open_positions",
      "risk_spread_cap",
      "risk_slippage_cap",
      "risk_sizing_unfeasible",
      "risk_portfolio_heat_cap",
      "risk_currency_exposure_cap",
      "risk_correlation_cap",
      "risk_redundant_position",
      "risk_redundant_strategy",
    ]);
  });

  it("boundary assertion passes for the matching approved decision", () => {
    const decision = evaluateRisk(baseRequest(), DEFAULT_RISK_LIMITS);
    expect(() => assertRiskGateCleared({ intentId: baseRequest().intentId }, decision)).not.toThrow();
  });

  it("boundary assertion fails closed on a rejected decision", () => {
    const rejected = evaluateRisk(baseRequest({ riskState: "kill" }), DEFAULT_RISK_LIMITS);
    expect(rejected.outcome).toBe("rejected");
    expect(() => assertRiskGateCleared({ intentId: baseRequest().intentId }, rejected)).toThrow(
      RiskBoundaryError,
    );
  });

  it("boundary assertion fails closed on an intent mismatch (no decision laundering)", () => {
    const decision = evaluateRisk(baseRequest(), DEFAULT_RISK_LIMITS);
    expect(() =>
      assertRiskGateCleared({ intentId: "btord_sig_other_intent" }, decision),
    ).toThrow(RiskBoundaryError);
  });

  it("boundary assertion fails closed on a foreign engine id", () => {
    const decision = evaluateRisk(baseRequest(), DEFAULT_RISK_LIMITS);
    const forged = { ...decision, riskEngineId: "not-the-risk-engine" } as unknown as RiskDecision;
    expect(() => assertRiskGateCleared({ intentId: baseRequest().intentId }, forged)).toThrow(
      RiskBoundaryError,
    );
  });

  it("boundary assertion fails closed when the decision state forbids new entries", () => {
    const approved = evaluateRisk(baseRequest(), DEFAULT_RISK_LIMITS);
    const forged = { ...approved, riskState: "orange" } as RiskDecision;
    expect(() => assertRiskGateCleared({ intentId: baseRequest().intentId }, forged)).toThrow(
      RiskBoundaryError,
    );
  });
});
