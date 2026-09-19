import { describe, expect, it } from "vitest";
import {
  BrokerReadOnlyService,
  BrokerReadOnlyViolationError,
  FORBIDDEN_BROKER_WRITE_METHODS,
} from "../broker/contract";
import {
  FixtureMt5Transport,
  Mt5ConnectionError,
  Mt5PayloadError,
  Mt5ReadOnlyAdapter,
  Mt5TransportError,
} from "../broker/mt5Adapter";
import {
  MT5_DEMO_ACCOUNT_FIXTURE,
  MT5_DEMO_DEALS_FIXTURE,
  MT5_DEMO_ORDERS_FIXTURE,
  MT5_DEMO_POSITIONS_FIXTURE,
  MT5_DEMO_TICKS_FIXTURE,
} from "../broker/mt5Fixtures";

describe("MT5 Read-Only Adapter (P15-02)", () => {
  it("populates canonical broker account from demo fixture", async () => {
    const transport = new FixtureMt5Transport();
    const adapter = new Mt5ReadOnlyAdapter(transport, { brokerId: "mt5-demo" });

    const account = await adapter.getAccount();
    expect(account.accountId).toBe("brkacc_mt5_50123456");
    expect(account.brokerId).toBe("mt5-demo");
    expect(account.accountNumber).toBe("50123456");
    expect(account.currency).toBe("USD");
    expect(account.balance).toBe(100000.0);
    expect(account.equity).toBe(100450.0);
    expect(account.margin).toBe(1500.0);
    expect(account.freeMargin).toBe(98950.0);
    expect(account.marginLevel).toBe(6696.67);
    expect(account.leverage).toBe(100);
    expect(account.isDemo).toBe(true);
    expect(account.serverName).toBe("MetaQuotes-Demo");
    expect(account.company).toBe("MetaQuotes Software Corp.");
    expect(new Date(account.updatedAtUtc).getTime()).toBeGreaterThan(0);
  });

  it("populates canonical quotes with calculated spread", async () => {
    const transport = new FixtureMt5Transport();
    const adapter = new Mt5ReadOnlyAdapter(transport);

    const quotes = await adapter.getQuotes(["EURUSD", "GBPUSD", "NONEXISTENT"]);
    expect(quotes.EURUSD).toBeDefined();
    expect(quotes.EURUSD.symbol).toBe("EURUSD");
    expect(quotes.EURUSD.bid).toBe(1.085);
    expect(quotes.EURUSD.ask).toBe(1.08515);
    expect(quotes.EURUSD.spread).toBe(0.00015);
    expect(quotes.EURUSD.atUtc).toBe("2026-09-12T08:00:00.000Z");

    expect(quotes.GBPUSD).toBeDefined();
    expect(quotes.NONEXISTENT).toBeUndefined();
  });

  it("populates canonical positions with normalized units and directions", async () => {
    const transport = new FixtureMt5Transport();
    const adapter = new Mt5ReadOnlyAdapter(transport, { lotSize: 100000 });

    const positions = await adapter.getPositions();
    expect(positions).toHaveLength(2);

    const longPos = positions.find((p) => p.symbol === "EURUSD")!;
    expect(longPos.positionId).toBe("brkpos_mt5_9001");
    expect(longPos.brokerTicket).toBe("9001");
    expect(longPos.direction).toBe("long");
    expect(longPos.quantityLots).toBe(0.5);
    expect(longPos.quantityUnits).toBe(50000);
    expect(longPos.openPrice).toBe(1.082);
    expect(longPos.currentPrice).toBe(1.085);
    expect(longPos.sl).toBe(1.078);
    expect(longPos.tp).toBe(1.092);
    expect(longPos.swap).toBe(-2.5);
    expect(longPos.commission).toBe(-3.5);
    expect(longPos.unrealizedProfit).toBe(150.0);
    expect(longPos.comment).toBe("strat_trend_01");
    expect(longPos.magic).toBe(1001);

    const shortPos = positions.find((p) => p.symbol === "GBPUSD")!;
    expect(shortPos.direction).toBe("short");
    expect(shortPos.quantityUnits).toBe(100000);
    expect(shortPos.unrealizedProfit).toBe(300.0);
  });
  it("populates canonical read-only orders with mapped state and type", async () => {
    const transport = new FixtureMt5Transport();
    const adapter = new Mt5ReadOnlyAdapter(transport);

    const orders = await adapter.getOrders();
    expect(orders).toHaveLength(1);

    const ord = orders[0];
    expect(ord.orderId).toBe("brkord_mt5_7001");
    expect(ord.brokerTicket).toBe("7001");
    expect(ord.symbol).toBe("EURUSD");
    expect(ord.side).toBe("buy");
    expect(ord.orderType).toBe("limit");
    expect(ord.state).toBe("open");
    expect(ord.lotsInitial).toBe(0.25);
    expect(ord.unitsInitial).toBe(25000);
    expect(ord.openPrice).toBe(1.08);
    expect(ord.sl).toBe(1.075);
    expect(ord.tp).toBe(1.09);
    expect(ord.comment).toBe("limit_order_01");
    expect(ord.magic).toBe(1001);
  });

  it("populates canonical historical deals and supports query filtering", async () => {
    const transport = new FixtureMt5Transport();
    const adapter = new Mt5ReadOnlyAdapter(transport);

    const trades = await adapter.getTrades();
    expect(trades).toHaveLength(2);

    const inDeal = trades[0];
    expect(inDeal.tradeId).toBe("brktrd_mt5_8001");
    expect(inDeal.entryType).toBe("in");
    expect(inDeal.realizedProfit).toBe(0);
    expect(inDeal.commission).toBe(-3.5);

    const outDeal = trades[1];
    expect(outDeal.tradeId).toBe("brktrd_mt5_8002");
    expect(outDeal.entryType).toBe("out");
    expect(outDeal.realizedProfit).toBe(250.0);
    expect(outDeal.swap).toBe(-1.2);

    // Filter by limit
    const limited = await adapter.getTrades({ limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].tradeId).toBe("brktrd_mt5_8001");

    // Filter by symbol
    const gbpDeals = await adapter.getTrades({ symbol: "GBPUSD" });
    expect(gbpDeals).toHaveLength(0);
  });

  it("reports healthy when bridge ping succeeds and unhealthy on disconnect", async () => {
    const transport = new FixtureMt5Transport();
    const adapter = new Mt5ReadOnlyAdapter(transport);

    const h1 = await adapter.getHealth();
    expect(h1.status).toBe("healthy");
    expect(h1.connected).toBe(true);
    expect(h1.latencyMs).toBe(5.0);

    // Disconnect transport
    transport.setConnected(false);
    const h2 = await adapter.getHealth();
    expect(h2.status).toBe("unhealthy");
    expect(h2.connected).toBe(false);
  });

  it("throws explicit Mt5ConnectionError when transport is disconnected", async () => {
    const transport = new FixtureMt5Transport({ connected: false });
    const adapter = new Mt5ReadOnlyAdapter(transport);

    await expect(adapter.getAccount()).rejects.toThrow(Mt5ConnectionError);
    await expect(adapter.getPositions()).rejects.toThrow(Mt5ConnectionError);
    await expect(adapter.getOrders()).rejects.toThrow(Mt5ConnectionError);
    await expect(adapter.getTrades()).rejects.toThrow(Mt5ConnectionError);
    await expect(adapter.getQuotes(["EURUSD"])).rejects.toThrow(Mt5ConnectionError);
  });

  it("throws explicit Mt5PayloadError when raw payload is corrupt", async () => {
    const corruptAccount = { ...MT5_DEMO_ACCOUNT_FIXTURE, login: "not-a-number" as any };
    const transport = new FixtureMt5Transport({ account: corruptAccount });
    const adapter = new Mt5ReadOnlyAdapter(transport);

    await expect(adapter.getAccount()).rejects.toThrow(Mt5PayloadError);
  });

  it("throws explicit Mt5PayloadError on inverted tick prices", async () => {
    const corruptTicks = {
      EURUSD: {
        symbol: "EURUSD",
        bid: 1.09,
        ask: 1.08, // inverted
        time: 1789200000,
      },
    };
    const transport = new FixtureMt5Transport({ ticks: corruptTicks });
    const adapter = new Mt5ReadOnlyAdapter(transport);

    await expect(adapter.getQuotes(["EURUSD"])).rejects.toThrow(Mt5PayloadError);
  });

  it("contains NO write operations and works seamlessly with BrokerReadOnlyService", async () => {
    const transport = new FixtureMt5Transport();
    const adapter = new Mt5ReadOnlyAdapter(transport);

    // Check that write operations are physically absent
    for (const method of FORBIDDEN_BROKER_WRITE_METHODS) {
      expect((adapter as any)[method]).toBeUndefined();
    }

    // BrokerReadOnlyService wrapping
    const service = new BrokerReadOnlyService(adapter);
    const acc = await service.getAccount();
    expect(acc.accountId).toBe("brkacc_mt5_50123456");

    // Dynamic write attempt on service throws
    expect(() => (service as any).order_send()).toThrow(BrokerReadOnlyViolationError);
  });

});
