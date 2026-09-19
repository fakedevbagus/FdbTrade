import { describe, expect, it } from "vitest";
import {
  BrokerReadOnlyAdapter,
  BrokerSyncEngine,
  BrokerSyncSnapshot,
  FixtureMt5Transport,
  Mt5ReadOnlyAdapter,
} from "../broker";

describe("Broker Quote and Account Sync Engine (P15-03)", () => {
  const syncTime = "2026-09-12T08:00:05.000Z"; // 5s after tick time 08:00:00

  it("performs complete sync and produces valid snapshot", async () => {
    const transport = new FixtureMt5Transport();
    const adapter = new Mt5ReadOnlyAdapter(transport);
    const engine = new BrokerSyncEngine(adapter, {
      symbols: ["EURUSD", "GBPUSD"],
      quoteMaxStalenessMs: 10000,
      accountMaxStalenessMs: 60000,
    });

    const snapshot = await engine.sync(syncTime);
    expect(snapshot.syncId).toMatch(/^bsync_[0-9a-f]{16}$/);
    expect(snapshot.brokerId).toBe("mt5-demo");
    expect(snapshot.account.balance).toBe(100000);
    expect(snapshot.quotes.EURUSD).toBeDefined();
    expect(snapshot.quotes.GBPUSD).toBeDefined();
    expect(snapshot.positions).toHaveLength(2);
    expect(snapshot.orders).toHaveLength(1);
    expect(snapshot.trades).toHaveLength(2);
    expect(snapshot.isStale).toBe(false);
    expect(snapshot.staleSymbols).toEqual([]);
    expect(snapshot.lastError).toBeNull();
  });

  it("is idempotent: repeated sync with same inputs yields identical syncId", async () => {
    const transport = new FixtureMt5Transport();
    const adapter = new Mt5ReadOnlyAdapter(transport);
    const engine = new BrokerSyncEngine(adapter, {
      symbols: ["EURUSD"],
      quoteMaxStalenessMs: 10000,
    });

    const snap1 = await engine.sync(syncTime);
    const snap2 = await engine.sync(syncTime);

    expect(snap1.syncId).toBe(snap2.syncId);
    expect(snap1.trades).toEqual(snap2.trades);
    expect(snap1.positions).toEqual(snap2.positions);
  });

  it("deduplicates historical trades across multiple sync passes", async () => {
    const transport = new FixtureMt5Transport();
    const adapter = new Mt5ReadOnlyAdapter(transport);
    const engine = new BrokerSyncEngine(adapter, {
      symbols: ["EURUSD"],
    });

    const snap1 = await engine.sync("2026-09-12T08:00:01.000Z");
    expect(snap1.trades).toHaveLength(2);

    const snap2 = await engine.sync("2026-09-12T08:00:02.000Z");
    expect(snap2.trades).toHaveLength(2); // Still 2, not 4
  });

  it("visibly marks stale quote state when age exceeds threshold", async () => {
    const transport = new FixtureMt5Transport();
    const adapter = new Mt5ReadOnlyAdapter(transport);
    const engine = new BrokerSyncEngine(adapter, {
      symbols: ["EURUSD"],
      quoteMaxStalenessMs: 5000, // 5s threshold
    });

    // Sync 15 seconds after tick time (2026-09-12T08:00:00.000Z)
    const staleTime = "2026-09-12T08:00:15.000Z";
    const snapshot = await engine.sync(staleTime);

    expect(snapshot.isStale).toBe(true);
    expect(snapshot.staleSymbols).toContain("EURUSD");
    expect(snapshot.quoteFreshness.EURUSD.isStale).toBe(true);
    expect(snapshot.quoteFreshness.EURUSD.ageMs).toBe(15000);
  });

  it("visibly marks stale when symbol is missing from broker quotes", async () => {
    const transport = new FixtureMt5Transport();
    const adapter = new Mt5ReadOnlyAdapter(transport);
    const engine = new BrokerSyncEngine(adapter, {
      symbols: ["EURUSD", "NONEXISTENT_PAIR"],
    });

    const snapshot = await engine.sync(syncTime);
    expect(snapshot.isStale).toBe(true);
    expect(snapshot.staleSymbols).toContain("NONEXISTENT_PAIR");
    expect(snapshot.quoteFreshness.NONEXISTENT_PAIR.isStale).toBe(true);
  });

  it("degrades fail-safe: retains previous snapshot marked stale on disconnect", async () => {
    const transport = new FixtureMt5Transport();
    const adapter = new Mt5ReadOnlyAdapter(transport);
    const engine = new BrokerSyncEngine(adapter, {
      symbols: ["EURUSD"],
    });

    // Successful first sync
    const snap1 = await engine.sync(syncTime);
    expect(snap1.isStale).toBe(false);

    // Now disconnect transport
    transport.setConnected(false);

    // Next sync should degrade safely without throwing
    const snap2 = await engine.sync("2026-09-12T08:00:10.000Z");
    expect(snap2.isStale).toBe(true);
    expect(snap2.lastError).toContain("disconnected");
    expect(snap2.account.balance).toBe(100000); // previous state preserved
  });

  it("throws fail-closed if first sync fails before any snapshot exists", async () => {
    const transport = new FixtureMt5Transport({ connected: false });
    const adapter = new Mt5ReadOnlyAdapter(transport);
    const engine = new BrokerSyncEngine(adapter, {
      symbols: ["EURUSD"],
    });

    await expect(engine.sync(syncTime)).rejects.toThrow();
  });
});
