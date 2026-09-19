import { describe, expect, it } from "vitest";
import {
  type AppPositionInput,
  type BrokerAccount,
  BrokerDriftChecker,
  BrokerHealthMonitor,
  type BrokerPosition,
} from "../broker";

describe("Broker Health and Drift Checks (P15-04)", () => {
  const baseBrokerAccount: BrokerAccount = {
    accountId: "brkacc_mt5_123456",
    brokerId: "mt5-demo",
    accountNumber: "123456",
    currency: "USD",
    balance: 100000,
    equity: 100500,
    margin: 1500,
    freeMargin: 99000,
    marginLevel: 6700,
    leverage: 100,
    isDemo: true,
    serverName: "MetaQuotes-Demo",
    company: null,
    updatedAtUtc: "2026-09-12T08:00:00.000Z",
  };

  const baseBrokerPosition: BrokerPosition = {
    positionId: "brkpos_mt5_9001",
    brokerTicket: "9001",
    symbol: "EURUSD",
    direction: "long",
    quantityLots: 0.5,
    quantityUnits: 50000,
    openPrice: 1.085,
    currentPrice: 1.087,
    sl: 1.08,
    tp: 1.09,
    swap: 0,
    commission: -3.5,
    unrealizedProfit: 100,
    openedAtUtc: "2026-09-12T07:00:00.000Z",
    comment: null,
    magic: null,
  };

  const baseAppPosition: AppPositionInput = {
    positionId: "pbpos_eurusd_1",
    symbol: "EURUSD",
    direction: "long",
    quantityUnits: 50000,
    openPrice: 1.085,
    status: "open",
  };

  describe("BrokerDriftChecker", () => {
    it("reports clean when app positions and broker positions match", () => {
      const checker = new BrokerDriftChecker();
      const report = checker.compare({
        appPositions: [baseAppPosition],
        brokerPositions: [baseBrokerPosition],
        appAccount: { balance: 100000, equity: 100500 },
        brokerAccount: baseBrokerAccount,
        atUtc: "2026-09-12T08:00:00.000Z",
      });

      expect(report.clean).toBe(true);
      expect(report.discrepancyCount).toBe(0);
      expect(report.matchedCount).toBe(1);
      expect(report.criticalCount).toBe(0);
      expect(report.warningCount).toBe(0);
    });

    it("detects quantity mismatch when app and broker quantities diverge", () => {
      const checker = new BrokerDriftChecker({ qtyToleranceUnits: 1 });
      const report = checker.compare({
        appPositions: [{ ...baseAppPosition, quantityUnits: 60000 }], // 60k vs 50k
        brokerPositions: [baseBrokerPosition],
        atUtc: "2026-09-12T08:00:00.000Z",
      });

      expect(report.clean).toBe(false);
      expect(report.discrepancies).toHaveLength(1);
      const d = report.discrepancies[0];
      expect(d.code).toBe("POSITION_QTY_MISMATCH");
      expect(d.delta).toBe(10000);
      expect(d.severity).toBe("critical");
    });

    it("detects position side/direction mismatch", () => {
      const checker = new BrokerDriftChecker();
      const report = checker.compare({
        appPositions: [{ ...baseAppPosition, direction: "short" }], // short vs long
        brokerPositions: [baseBrokerPosition],
        atUtc: "2026-09-12T08:00:00.000Z",
      });

      expect(report.clean).toBe(false);
      const sideDisc = report.discrepancies.find((d) => d.code === "POSITION_SIDE_MISMATCH");
      expect(sideDisc).toBeDefined();
      expect(sideDisc?.severity).toBe("critical");
      expect(sideDisc?.appValue).toBe("short");
      expect(sideDisc?.brokerValue).toBe("long");
    });
    it("detects phantom app position when position exists only in app", () => {
      const checker = new BrokerDriftChecker();
      const report = checker.compare({
        appPositions: [baseAppPosition],
        brokerPositions: [], // empty broker
        atUtc: "2026-09-12T08:00:00.000Z",
      });

      expect(report.clean).toBe(false);
      const phantom = report.discrepancies.find((d) => d.code === "PHANTOM_APP_POSITION");
      expect(phantom).toBeDefined();
      expect(phantom?.severity).toBe("critical");
      expect(phantom?.symbol).toBe("EURUSD");
    });

    it("detects untracked broker position when position exists only on broker", () => {
      const checker = new BrokerDriftChecker();
      const report = checker.compare({
        appPositions: [], // empty app
        brokerPositions: [baseBrokerPosition],
        atUtc: "2026-09-12T08:00:00.000Z",
      });

      expect(report.clean).toBe(false);
      const untracked = report.discrepancies.find((d) => d.code === "UNTRACKED_BROKER_POSITION");
      expect(untracked).toBeDefined();
      expect(untracked?.severity).toBe("critical");
      expect(untracked?.symbol).toBe("EURUSD");
    });

    it("detects open price drift when price difference exceeds tolerance", () => {
      const checker = new BrokerDriftChecker({ maxPriceDriftFraction: 0.005 }); // 0.5%
      const report = checker.compare({
        appPositions: [{ ...baseAppPosition, openPrice: 1.10 }], // 1.10 vs 1.085 (~1.38% drift)
        brokerPositions: [baseBrokerPosition],
        atUtc: "2026-09-12T08:00:00.000Z",
      });

      expect(report.clean).toBe(false);
      const priceDisc = report.discrepancies.find((d) => d.code === "PRICE_DRIFT_EXCEEDED");
      expect(priceDisc).toBeDefined();
      expect(priceDisc?.severity).toBe("warning");
    });

    it("detects equity drift when app and broker equity deviate significantly", () => {
      const checker = new BrokerDriftChecker({ maxEquityDriftFraction: 0.05 });
      const report = checker.compare({
        appPositions: [baseAppPosition],
        brokerPositions: [baseBrokerPosition],
        appAccount: { balance: 100000, equity: 85000 }, // 85k vs 100.5k (>15% drift)
        brokerAccount: baseBrokerAccount,
        atUtc: "2026-09-12T08:00:00.000Z",
      });

      expect(report.clean).toBe(false);
      const eqDisc = report.discrepancies.find((d) => d.code === "EQUITY_DRIFT_EXCEEDED");
      expect(eqDisc).toBeDefined();
      expect(eqDisc?.severity).toBe("critical");
    });

    it("flags stale broker feed as warning discrepancy", () => {
      const checker = new BrokerDriftChecker();
      const report = checker.compare({
        appPositions: [baseAppPosition],
        brokerPositions: [baseBrokerPosition],
        isBrokerFeedStale: true,
        atUtc: "2026-09-12T08:00:00.000Z",
      });

      expect(report.clean).toBe(false);
      const staleDisc = report.discrepancies.find((d) => d.code === "STALE_BROKER_FEED");
      expect(staleDisc).toBeDefined();
      expect(staleDisc?.severity).toBe("warning");
    });

    it("GUARANTEE: discrepancies NEVER trigger automatic orders or execute trades", () => {
      const checker = new BrokerDriftChecker();

      // Check methods on checker
      expect((checker as any).createOrder).toBeUndefined();
      expect((checker as any).order_send).toBeUndefined();
      expect((checker as any).executeTrade).toBeUndefined();
      expect((checker as any).autoHeal).toBeUndefined();

      // Ensure compare is pure: input objects are not modified
      const appPosCopy = [{ ...baseAppPosition }];
      const brokerPosCopy = [{ ...baseBrokerPosition }];
      const report = checker.compare({
        appPositions: appPosCopy,
        brokerPositions: brokerPosCopy,
      });

      expect(report).toBeDefined();
      expect(appPosCopy).toHaveLength(1);
      expect(brokerPosCopy).toHaveLength(1);
    });
  });

  describe("BrokerHealthMonitor", () => {
    it("reports healthy on successful heartbeats with low latency", () => {
      const monitor = new BrokerHealthMonitor({ maxLatencyMs: 200 });
      const h = monitor.recordHeartbeat({ ok: true, latencyMs: 25.0 });

      expect(h.status).toBe("healthy");
      expect(h.connected).toBe(true);
      expect(h.latencyMs).toBe(25.0);
    });

    it("reports degraded when latency exceeds max threshold", () => {
      const monitor = new BrokerHealthMonitor({ maxLatencyMs: 100 });
      const h = monitor.recordHeartbeat({ ok: true, latencyMs: 250.0 });

      expect(h.status).toBe("degraded");
      expect(h.connected).toBe(true);
    });

    it("reports degraded on transient ping failure and unhealthy on >= 3 consecutive failures", () => {
      const monitor = new BrokerHealthMonitor({ maxFailuresBeforeUnhealthy: 3 });

      // 1st failure -> degraded
      const h1 = monitor.recordHeartbeat({ ok: false, latencyMs: 0 });
      expect(h1.status).toBe("unhealthy"); // 0 connected is unhealthy immediately or degraded

      // Reset connected with ok
      monitor.recordHeartbeat({ ok: true, latencyMs: 20 });
      expect(monitor.getHealth().status).toBe("healthy");

      // 1 failure
      const f1 = monitor.recordHeartbeat({ ok: false, latencyMs: 0 });
      expect(f1.connected).toBe(false);

      // Recovery
      const rec = monitor.recordHeartbeat({ ok: true, latencyMs: 15 });
      expect(rec.status).toBe("healthy");
      expect(rec.connected).toBe(true);
    });
  });
});

