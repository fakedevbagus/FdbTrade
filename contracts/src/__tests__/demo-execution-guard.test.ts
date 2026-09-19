/**
 * Unit tests for Demo Execution Guard and Guarded Service (P16-01, ADR-0030).
 */
import { describe, expect, it } from "vitest";

import type { BrokerAccount, BrokerReadOnlyAdapter } from "../broker/contract";
import {
  DemoEndpointForbiddenError,
  DemoExecutionGuard,
  DemoMisconfigurationError,
  LiveCredentialsRejectedError,
} from "../execution/guard";
import { DemoExecutionService, type DemoWireTransport } from "../execution/adapter";
import type { DemoOrderIntent } from "../execution/contract";

function createValidDemoAccount(overrides?: Partial<BrokerAccount>): BrokerAccount {
  return {
    accountId: "demo_acc_1001",
    brokerId: "mt5-demo",
    accountNumber: "50123456",
    currency: "USD",
    balance: 50000.0,
    equity: 50000.0,
    margin: 0.0,
    freeMargin: 50000.0,
    marginLevel: null,
    leverage: 100,
    isDemo: true,
    serverName: "MetaQuotes-Demo",
    company: "MetaQuotes Software Corp.",
    updatedAtUtc: "2026-09-12T12:00:00.000Z",
    ...overrides,
  };
}

function createMockReadOnlyAdapter(account?: BrokerAccount): BrokerReadOnlyAdapter {
  const acc = account ?? createValidDemoAccount();
  return {
    adapterName: "test-read-only-adapter",
    brokerId: "test-broker",
    getAccount: async () => acc,
    getQuotes: async () => ({}),
    getPositions: async () => [],
    getOrders: async () => [],
    getTrades: async () => [],
    getHealth: async () => ({
      adapterName: "test-read-only-adapter",
      brokerId: "test-broker",
      status: "healthy",
      connected: true,
      latencyMs: 5.0,
      lastHeartbeatUtc: "2026-09-12T12:00:00.000Z",
      message: "ok",
      details: {},
    }),
  };
}

function createValidIntent(overrides?: Partial<DemoOrderIntent>): DemoOrderIntent {
  return {
    intentId: "intent_001",
    signalId: "sig_001",
    accountId: "demo_acc_1001",
    symbol: "EURUSD",
    side: "buy",
    orderType: "market",
    volumeUnits: 10000,
    version: 1,
    createdAtUtc: "2026-09-12T12:00:00.000Z",
    ...overrides,
  };
}

describe("DemoExecutionGuard (P16-01)", () => {
  it("initializes successfully with valid demo configuration", () => {
    const guard = new DemoExecutionGuard({
      demoExecutionEnabled: true,
      environment: "test",
    });

    expect(guard.getConfig().demoExecutionEnabled).toBe(true);
    expect(guard.getConfig().liveExecutionEnabled).toBe(false);
    expect(guard.getConfig().environment).toBe("test");
  });

  it("fails closed if liveExecutionEnabled is set to true", () => {
    expect(() => {
      new DemoExecutionGuard({
        demoExecutionEnabled: true,
        liveExecutionEnabled: true as any,
      });
    }).toThrow(DemoMisconfigurationError);
  });

  it("blocks validateStartup if demoExecutionEnabled is false", () => {
    const guard = new DemoExecutionGuard({
      demoExecutionEnabled: false,
    });

    expect(() => guard.validateStartup()).toThrow(DemoMisconfigurationError);
  });

  it("blocks validateStartup if environment is production", () => {
    expect(() => {
      new DemoExecutionGuard({
        demoExecutionEnabled: true,
        environment: "production" as any,
      });
    }).toThrow(DemoMisconfigurationError);
  });

  it("accepts valid demo account with isDemo=true and approved demo server", () => {
    const guard = new DemoExecutionGuard({ demoExecutionEnabled: true });
    const account = createValidDemoAccount();

    expect(() => guard.validateBrokerAccount(account)).not.toThrow();
  });

  it("strictly rejects broker account with isDemo=false (LiveCredentialsRejectedError)", () => {
    const guard = new DemoExecutionGuard({ demoExecutionEnabled: true });
    const liveAccount = createValidDemoAccount({ isDemo: false });

    expect(() => guard.validateBrokerAccount(liveAccount)).toThrow(
      LiveCredentialsRejectedError,
    );
  });

  it("strictly rejects broker account with live server name pattern", () => {
    const guard = new DemoExecutionGuard({ demoExecutionEnabled: true });
    const liveServerAccount = createValidDemoAccount({
      isDemo: true,
      serverName: "MetaQuotes-Live",
    });

    expect(() => guard.validateBrokerAccount(liveServerAccount)).toThrow(
      LiveCredentialsRejectedError,
    );

    const realServerAccount = createValidDemoAccount({
      isDemo: true,
      serverName: "Broker-Real-01",
    });
    expect(() => guard.validateBrokerAccount(realServerAccount)).toThrow(
      LiveCredentialsRejectedError,
    );
  });

  it("rejects server not on approved demo whitelist", () => {
    const guard = new DemoExecutionGuard({
      demoExecutionEnabled: true,
      approvedDemoServers: ["MetaQuotes-Demo"],
    });
    const unapprovedAccount = createValidDemoAccount({
      isDemo: true,
      serverName: "UnknownBroker-Server1",
    });

    expect(() => guard.validateBrokerAccount(unapprovedAccount)).toThrow(
      DemoEndpointForbiddenError,
    );
  });

  it("validates endpoint URI and rejects live endpoints", () => {
    const guard = new DemoExecutionGuard({ demoExecutionEnabled: true });

    expect(() => guard.validateEndpoint("demo.mt5.broker.com:443")).not.toThrow();
    expect(() => guard.validateEndpoint("localhost:5000")).not.toThrow();
    expect(() => guard.validateEndpoint("mock://demo")).not.toThrow();

    expect(() => guard.validateEndpoint("live.mt5.broker.com:443")).toThrow(
      LiveCredentialsRejectedError,
    );
    expect(() => guard.validateEndpoint("prod-trade.broker.internal:9000")).toThrow(
      LiveCredentialsRejectedError,
    );
    expect(() => guard.validateEndpoint("unknown.broker.com:443")).toThrow(
      DemoEndpointForbiddenError,
    );
  });

  it("enforces volume limit and allowed symbols guards", () => {
    const guard = new DemoExecutionGuard({
      demoExecutionEnabled: true,
      maxOrderVolume: 50000,
      allowedSymbols: ["EURUSD", "GBPUSD"],
    });
    const account = createValidDemoAccount();

    expect(() =>
      guard.assertCanSubmitOrder(account, { volumeUnits: 10000, symbol: "EURUSD" }),
    ).not.toThrow();

    expect(() =>
      guard.assertCanSubmitOrder(account, { volumeUnits: 60000, symbol: "EURUSD" }),
    ).toThrow(DemoMisconfigurationError);

    expect(() =>
      guard.assertCanSubmitOrder(account, { volumeUnits: 10000, symbol: "USDJPY" }),
    ).toThrow(DemoMisconfigurationError);
  });

  it("evaluates isOrderSubmissionAllowed without throwing", () => {
    const guard = new DemoExecutionGuard({ demoExecutionEnabled: true });
    const account = createValidDemoAccount();

    const allowed = guard.isOrderSubmissionAllowed(account);
    expect(allowed.allowed).toBe(true);

    const liveAcc = createValidDemoAccount({ isDemo: false });
    const disallowed = guard.isOrderSubmissionAllowed(liveAcc);
    expect(disallowed.allowed).toBe(false);
    expect(disallowed.reason).toContain("Only demo accounts permitted");
  });
});

describe("DemoExecutionService (P16-01)", () => {
  it("submits demo order successfully when environment and account are valid", async () => {
    const guard = new DemoExecutionGuard({ demoExecutionEnabled: true });
    const readOnlyAdapter = createMockReadOnlyAdapter();
    const service = new DemoExecutionService({ readOnlyAdapter, guard });

    const intent = createValidIntent();
    const result = await service.submitDemoOrder("ord_demo_test1", intent);

    expect(result.clientOrderId).toBe("ord_demo_test1");
    expect(result.intentId).toBe("intent_001");
    expect(result.status).toBe("acknowledged");
    expect(result.volumeRequested).toBe(10000);
    expect(result.volumeFilled).toBe(0);
    expect(result.symbol).toBe("EURUSD");
  });

  it("submits through wire transport when provided", async () => {
    const guard = new DemoExecutionGuard({ demoExecutionEnabled: true });
    const readOnlyAdapter = createMockReadOnlyAdapter();
    const wireTransport: DemoWireTransport = {
      sendDemoOrder: async (clientOrderId, intent) => ({
        brokerTicket: "wire_ticket_999",
        status: "filled",
        filledUnits: intent.volumeUnits,
        price: 1.0855,
      }),
      cancelDemoOrder: async () => ({ status: "cancelled" }),
    };

    const service = new DemoExecutionService({
      readOnlyAdapter,
      guard,
      wireTransport,
    });

    const intent = createValidIntent();
    const result = await service.submitDemoOrder("ord_demo_wire1", intent);

    expect(result.clientOrderId).toBe("ord_demo_wire1");
    expect(result.brokerTicket).toBe("wire_ticket_999");
    expect(result.status).toBe("filled");
    expect(result.volumeFilled).toBe(10000);
    expect(result.averagePrice).toBe(1.0855);
  });

  it("blocks order submission if demo execution is disabled", async () => {
    const guard = new DemoExecutionGuard({ demoExecutionEnabled: false });
    const readOnlyAdapter = createMockReadOnlyAdapter();
    const service = new DemoExecutionService({ readOnlyAdapter, guard });

    const intent = createValidIntent();
    await expect(service.submitDemoOrder("ord_demo_fail", intent)).rejects.toThrow(
      DemoMisconfigurationError,
    );
  });

  it("blocks order submission if broker account is live/production", async () => {
    const guard = new DemoExecutionGuard({ demoExecutionEnabled: true });
    const liveAccount = createValidDemoAccount({ isDemo: false });
    const readOnlyAdapter = createMockReadOnlyAdapter(liveAccount);
    const service = new DemoExecutionService({ readOnlyAdapter, guard });

    const intent = createValidIntent();
    await expect(service.submitDemoOrder("ord_demo_live_fail", intent)).rejects.toThrow(
      LiveCredentialsRejectedError,
    );
  });
});

