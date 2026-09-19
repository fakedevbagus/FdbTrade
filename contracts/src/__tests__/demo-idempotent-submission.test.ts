/**
 * Unit tests for idempotent order submission (P16-02, ADR-0030).
 */
import { describe, expect, it } from "vitest";

import { DemoExecutionService } from "../execution/adapter";
import { clientOrderIdFor, InMemoryDemoSubmissionStore } from "../execution/idempotency";
import { IdempotentDemoOrderSubmitter } from "../execution/submitter";
import { DemoExecutionGuard } from "../execution/guard";
import type { DemoOrderIntent } from "../execution/contract";

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

function createService(options?: {
  sendCalls?: { count: number };
}): { service: DemoExecutionService; sendCalls: { count: number } } {
  const sendCalls = options?.sendCalls ?? { count: 0 };

  const readOnlyAdapter = {
    adapterName: "test-ro",
    brokerId: "test-broker",
    getAccount: async () => ({
      accountId: "demo_acc_1001",
      brokerId: "mt5-demo",
      accountNumber: "50123456",
      currency: "USD",
      balance: 50000,
      equity: 50000,
      margin: 0,
      freeMargin: 50000,
      marginLevel: null,
      leverage: 100,
      isDemo: true,
      serverName: "MetaQuotes-Demo",
      company: null,
      updatedAtUtc: "2026-09-12T12:00:00.000Z",
    }),
    getQuotes: async () => ({}),
    getPositions: async () => [],
    getOrders: async () => [],
    getTrades: async () => [],
    getHealth: async () => ({
      adapterName: "test-ro",
      brokerId: "test-broker",
      status: "healthy" as const,
      connected: true,
      latencyMs: 5,
      lastHeartbeatUtc: "2026-09-12T12:00:00.000Z",
      message: "ok",
      details: {},
    }),
  };

  const wireTransport = {
    sendDemoOrder: async (clientOrderId: string, intent: DemoOrderIntent) => {
      sendCalls.count += 1;
      return {
        brokerTicket: `ticket_${sendCalls.count}`,
        status: "acknowledged" as const,
        filledUnits: 0,
        price: null,
      };
    },
    cancelDemoOrder: async () => ({ status: "cancelled" as const }),
  };

  const guard = new DemoExecutionGuard({ demoExecutionEnabled: true });
  const service = new DemoExecutionService({
    readOnlyAdapter,
    guard,
    wireTransport,
  });

  return { service, sendCalls };
}

describe("clientOrderIdFor (P16-02)", () => {
  it("generates deterministic id from same intent", () => {
    const intent = createValidIntent();
    const id1 = clientOrderIdFor(intent);
    const id2 = clientOrderIdFor(intent);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^dclo_[0-9a-f]{16}$/);
  });

  it("generates different id when version changes", () => {
    const intent1 = createValidIntent({ version: 1 });
    const intent2 = createValidIntent({ version: 2 });
    expect(clientOrderIdFor(intent1)).not.toBe(clientOrderIdFor(intent2));
  });

  it("generates different id when signalId changes", () => {
    const intent1 = createValidIntent({ signalId: "sig_a" });
    const intent2 = createValidIntent({ signalId: "sig_b" });
    expect(clientOrderIdFor(intent1)).not.toBe(clientOrderIdFor(intent2));
  });

  it("generates different id when accountId changes", () => {
    const intent1 = createValidIntent({ accountId: "acc_1" });
    const intent2 = createValidIntent({ accountId: "acc_2" });
    expect(clientOrderIdFor(intent1)).not.toBe(clientOrderIdFor(intent2));
  });
});

describe("InMemoryDemoSubmissionStore (P16-02)", () => {
  it("returns null for unknown clientOrderId", () => {
    const store = new InMemoryDemoSubmissionStore();
    expect(store.findByClientOrderId("unknown")).toBeNull();
  });

  it("persists and retrieves pending submission", () => {
    const store = new InMemoryDemoSubmissionStore();
    const record = {
      clientOrderId: "dclo_test001",
      intent: createValidIntent(),
      firstSubmittedAtUtc: "2026-09-12T12:00:00.000Z",
      lastAttemptAtUtc: "2026-09-12T12:00:00.000Z",
      attemptCount: 1,
      brokerTicket: null,
      status: "pending" as const,
      response: null,
    };
    store.savePending(record);

    const found = store.findByClientOrderId("dclo_test001");
    expect(found).not.toBeNull();
    expect(found!.status).toBe("pending");
    expect(found!.attemptCount).toBe(1);
  });

  it("increments attempt count on repeated savePending", () => {
    const store = new InMemoryDemoSubmissionStore();
    const record = {
      clientOrderId: "dclo_retry",
      intent: createValidIntent(),
      firstSubmittedAtUtc: "2026-09-12T12:00:00.000Z",
      lastAttemptAtUtc: "2026-09-12T12:00:01.000Z",
      attemptCount: 1,
      brokerTicket: null,
      status: "pending" as const,
      response: null,
    };
    store.savePending(record);
    store.savePending({ ...record, lastAttemptAtUtc: "2026-09-12T12:00:02.000Z" });
    store.savePending({ ...record, lastAttemptAtUtc: "2026-09-12T12:00:03.000Z" });

    const found = store.findByClientOrderId("dclo_retry");
    expect(found!.attemptCount).toBe(3);
    expect(found!.firstSubmittedAtUtc).toBe("2026-09-12T12:00:00.000Z");
  });

  it("records broker response after reconciliation", () => {
    const store = new InMemoryDemoSubmissionStore();
    store.savePending({
      clientOrderId: "dclo_resp",
      intent: createValidIntent(),
      firstSubmittedAtUtc: "2026-09-12T12:00:00.000Z",
      lastAttemptAtUtc: "2026-09-12T12:00:00.000Z",
      attemptCount: 1,
      brokerTicket: null,
      status: "pending",
      response: null,
    });

    store.recordResponse(
      "dclo_resp",
      "broker_ticket_99",
      "acknowledged",
      { foo: "bar" },
      "2026-09-12T12:00:01.000Z",
    );

    const found = store.findByClientOrderId("dclo_resp");
    expect(found!.status).toBe("acknowledged");
    expect(found!.brokerTicket).toBe("broker_ticket_99");
  });
});

describe("IdempotentDemoOrderSubmitter (P16-02)", () => {
  it("submits once and returns result from ledger on retry", async () => {
    const { service, sendCalls } = createService();
    const store = new InMemoryDemoSubmissionStore();
    const submitter = new IdempotentDemoOrderSubmitter({
      service,
      store,
      nowFn: () => "2026-09-12T12:00:00.000Z",
    });

    const intent = createValidIntent();
    const result1 = await submitter.submit(intent);
    expect(result1.status).toBe("acknowledged");
    expect(sendCalls.count).toBe(1);

    // Same intent retry: should return cached result, NOT call broker again
    const result2 = await submitter.submit(intent);
    expect(result2.clientOrderId).toBe(result1.clientOrderId);
    expect(sendCalls.count).toBe(1); // Still 1 — no new broker call
  });

  it("new intent version creates a new broker order", async () => {
    const { service, sendCalls } = createService();
    const store = new InMemoryDemoSubmissionStore();
    const submitter = new IdempotentDemoOrderSubmitter({
      service,
      store,
      nowFn: () => "2026-09-12T12:00:00.000Z",
    });

    const intent_v1 = createValidIntent({ version: 1 });
    const intent_v2 = createValidIntent({ version: 2 });

    await submitter.submit(intent_v1);
    await submitter.submit(intent_v2);

    expect(sendCalls.count).toBe(2);
    expect(store.all().length).toBe(2);
  });

  it("malformed intent rejects before reaching store", async () => {
    const { service } = createService();
    const store = new InMemoryDemoSubmissionStore();
    const submitter = new IdempotentDemoOrderSubmitter({
      service,
      store,
      nowFn: () => "2026-09-12T12:00:00.000Z",
    });

    const badIntent = { ...createValidIntent(), symbol: "" } as DemoOrderIntent;
    await expect(submitter.submit(badIntent)).rejects.toThrow();
    expect(store.all().length).toBe(0);
  });
});

