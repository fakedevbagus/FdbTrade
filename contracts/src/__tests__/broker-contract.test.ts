import { describe, expect, it } from "vitest";
import {
  type BrokerAccount,
  brokerAccountSchema,
  BrokerContractError,
  brokerHealthSchema,
  brokerOrderReadSchema,
  brokerPositionSchema,
  brokerQuoteSchema,
  BrokerReadOnlyAdapter,
  BrokerReadOnlyService,
  BrokerReadOnlyViolationError,
  brokerTradesQuerySchema,
  brokerTradeSchema,
  FORBIDDEN_BROKER_WRITE_METHODS,
} from "../broker/contract";

describe("Broker Read-Only Contracts (P15-01)", () => {
  const validAccount: BrokerAccount = {
    accountId: "brkacc_mt5_123456",
    brokerId: "mt5-demo",
    accountNumber: "123456",
    currency: "USD",
    balance: 100000.0,
    equity: 100520.5,
    margin: 1500.0,
    freeMargin: 99020.5,
    marginLevel: 6701.37,
    leverage: 100,
    isDemo: true,
    serverName: "MetaQuotes-Demo",
    company: "MetaQuotes Ltd.",
    updatedAtUtc: "2026-09-12T10:00:00.000Z",
  };

  describe("brokerAccountSchema", () => {
    it("parses valid broker account", () => {
      const parsed = brokerAccountSchema.parse(validAccount);
      expect(parsed.balance).toBe(100000.0);
      expect(parsed.isDemo).toBe(true);
      expect(parsed.currency).toBe("USD");
    });

    it("allows null marginLevel when margin is zero", () => {
      const parsed = brokerAccountSchema.parse({
        ...validAccount,
        margin: 0,
        marginLevel: null,
      });
      expect(parsed.margin).toBe(0);
      expect(parsed.marginLevel).toBeNull();
    });

    it("rejects invalid currency format", () => {
      expect(() =>
        brokerAccountSchema.parse({ ...validAccount, currency: "us" }),
      ).toThrow();
    });

    it("rejects negative leverage or zero leverage", () => {
      expect(() =>
        brokerAccountSchema.parse({ ...validAccount, leverage: 0 }),
      ).toThrow();
    });

    it("rejects non-finite values", () => {
      expect(() =>
        brokerAccountSchema.parse({ ...validAccount, balance: Number.NaN }),
      ).toThrow();
    });
  });

  describe("brokerQuoteSchema", () => {
    it("parses valid quote", () => {
      const parsed = brokerQuoteSchema.parse({
        symbol: "EURUSD",
        bid: 1.085,
        ask: 1.0852,
        spread: 0.0002,
        atUtc: "2026-09-12T10:00:00.000Z",
      });
      expect(parsed.symbol).toBe("EURUSD");
      expect(parsed.spread).toBe(0.0002);
    });

    it("rejects when ask is lower than bid", () => {
      expect(() =>
        brokerQuoteSchema.parse({
          symbol: "EURUSD",
          bid: 1.0855,
          ask: 1.085,
          spread: 0.0002,
          atUtc: "2026-09-12T10:00:00.000Z",
        }),
      ).toThrow("ask price must be greater than or equal to bid price");
    });

    it("rejects negative spread", () => {
      expect(() =>
        brokerQuoteSchema.parse({
          symbol: "EURUSD",
          bid: 1.085,
          ask: 1.0852,
          spread: -0.0001,
          atUtc: "2026-09-12T10:00:00.000Z",
        }),
      ).toThrow();
    });
  });

  describe("brokerPositionSchema", () => {
    it("parses valid long position", () => {
      const pos = brokerPositionSchema.parse({
        positionId: "brkpos_mt5_987654",
        brokerTicket: "987654",
        symbol: "EURUSD",
        direction: "long",
        quantityLots: 0.1,
        quantityUnits: 10000,
        openPrice: 1.085,
        currentPrice: 1.086,
        sl: 1.08,
        tp: 1.09,
        swap: -1.25,
        commission: -3.5,
        unrealizedProfit: 10.0,
        openedAtUtc: "2026-09-12T09:30:00.000Z",
        comment: "strategy-breakout",
        magic: 101,
      });
      expect(pos.direction).toBe("long");
      expect(pos.unrealizedProfit).toBe(10.0);
    });

    it("parses position with null sl/tp", () => {
      const pos = brokerPositionSchema.parse({
        positionId: "brkpos_mt5_987655",
        brokerTicket: "987655",
        symbol: "GBPUSD",
        direction: "short",
        quantityLots: 1.0,
        quantityUnits: 100000,
        openPrice: 1.25,
        currentPrice: 1.248,
        sl: null,
        tp: null,
        swap: 0,
        commission: -7.0,
        unrealizedProfit: 200.0,
        openedAtUtc: "2026-09-12T09:45:00.000Z",
      });
      expect(pos.sl).toBeNull();
      expect(pos.tp).toBeNull();
    });

    it("rejects invalid direction", () => {
      expect(() =>
        brokerPositionSchema.parse({
          positionId: "brkpos_mt5_1",
          brokerTicket: "1",
          symbol: "EURUSD",
          direction: "flat" as any,
          quantityLots: 1,
          quantityUnits: 100000,
          openPrice: 1.08,
          currentPrice: 1.08,
          sl: null,
          tp: null,
          swap: 0,
          commission: 0,
          unrealizedProfit: 0,
          openedAtUtc: "2026-09-12T10:00:00.000Z",
        }),
      ).toThrow();
    });
  });

  describe("brokerOrderReadSchema", () => {
    it("parses valid limit order", () => {
      const ord = brokerOrderReadSchema.parse({
        orderId: "brkord_mt5_555",
        brokerTicket: "555",
        symbol: "EURUSD",
        side: "buy",
        orderType: "limit",
        state: "open",
        lotsInitial: 0.5,
        lotsCurrent: 0.5,
        unitsInitial: 50000,
        unitsCurrent: 50000,
        openPrice: 1.08,
        sl: 1.075,
        tp: 1.09,
        createdAtUtc: "2026-09-12T08:00:00.000Z",
        expiresAtUtc: null,
      });
      expect(ord.orderType).toBe("limit");
      expect(ord.state).toBe("open");
    });
  });

  describe("brokerTradeSchema", () => {
    it("parses valid historical deal", () => {
      const trd = brokerTradeSchema.parse({
        tradeId: "brktrd_mt5_111",
        brokerTicket: "111",
        orderTicket: "555",
        positionTicket: "987654",
        symbol: "EURUSD",
        side: "sell",
        entryType: "out",
        quantityLots: 0.1,
        quantityUnits: 10000,
        price: 1.086,
        commission: -1.75,
        swap: -0.5,
        realizedProfit: 10.0,
        closedAtUtc: "2026-09-12T09:50:00.000Z",
      });
      expect(trd.entryType).toBe("out");
      expect(trd.realizedProfit).toBe(10.0);
    });
  });

  describe("brokerHealthSchema", () => {
    it("parses valid healthy status", () => {
      const h = brokerHealthSchema.parse({
        adapterName: "mt5-read-only-adapter",
        brokerId: "mt5-demo",
        status: "healthy",
        connected: true,
        latencyMs: 12.5,
        lastHeartbeatUtc: "2026-09-12T10:00:00.000Z",
        message: "Connected to demo server",
        details: { pingCount: 42 },
      });
      expect(h.status).toBe("healthy");
      expect(h.connected).toBe(true);
    });
  });

  describe("brokerTradesQuerySchema", () => {
    it("accepts valid query parameters", () => {
      const q = brokerTradesQuerySchema.parse({
        sinceUtc: "2026-09-01T00:00:00.000Z",
        limit: 100,
        symbol: "EURUSD",
      });
      expect(q.limit).toBe(100);
    });

    it("rejects limit over max 10000", () => {
      expect(() =>
        brokerTradesQuerySchema.parse({
          limit: 10001,
        }),
      ).toThrow();
    });
  });

  describe("BrokerReadOnlyService (boundary enforcement)", () => {
    function createMockAdapter(): BrokerReadOnlyAdapter {
      return {
        adapterName: "test-mock-adapter",
        brokerId: "mock-broker",
        getAccount: async () => validAccount,
        getQuotes: async () => ({
          EURUSD: {
            symbol: "EURUSD",
            bid: 1.085,
            ask: 1.0852,
            spread: 0.0002,
            atUtc: "2026-09-12T10:00:00.000Z",
          },
        }),
        getPositions: async () => [],
        getOrders: async () => [],
        getTrades: async () => [],
        getHealth: async () => ({
          adapterName: "test-mock-adapter",
          brokerId: "mock-broker",
          status: "healthy",
          connected: true,
          latencyMs: 5.0,
          lastHeartbeatUtc: "2026-09-12T10:00:00.000Z",
          message: null,
          details: {},
        }),
      };
    }

    it("compiles and proxies read calls correctly", async () => {
      const adapter = createMockAdapter();
      const service = new BrokerReadOnlyService(adapter);

      const acc = await service.getAccount();
      expect(acc.accountId).toBe("brkacc_mt5_123456");

      const quotes = await service.getQuotes(["EURUSD"]);
      expect(quotes.EURUSD.bid).toBe(1.085);

      const positions = await service.getPositions();
      expect(positions).toEqual([]);

      const orders = await service.getOrders();
      expect(orders).toEqual([]);

      const trades = await service.getTrades();
      expect(trades).toEqual([]);

      const health = await service.getHealth();
      expect(health.status).toBe("healthy");
    });

    it("fails closed on malformed adapter response", async () => {
      const adapter = createMockAdapter();
      adapter.getAccount = async () => ({ ...validAccount, balance: "invalid" as any });
      const service = new BrokerReadOnlyService(adapter);

      await expect(service.getAccount()).rejects.toThrow();
    });

    it("rejects adapter that contains forbidden write methods at construction", () => {
      const badAdapter: any = {
        ...createMockAdapter(),
        createOrder: () => {},
      };
      expect(() => new BrokerReadOnlyService(badAdapter)).toThrow(
        BrokerReadOnlyViolationError,
      );
    });

    it("blocks dynamic invocation of forbidden write methods via service proxy", () => {
      const service: any = new BrokerReadOnlyService(createMockAdapter());

      for (const method of FORBIDDEN_BROKER_WRITE_METHODS) {
        expect(() => service[method]).toThrow(BrokerReadOnlyViolationError);
      }
    });
  });
});

