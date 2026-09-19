/**
 * Paper fill simulator tests (P10-02).
 *
 * Acceptance: known fixtures produce expected fills and PnL. Deterministic
 * fixtures only: closed 1h EURUSD candles, frozen cost policy, no randomness.
 */
import { describe, expect, it } from "vitest";

import {
  paperOrderFromIntent,
  paperRealisticFill,
  simulateOrderEntryFills,
  simulatePaperRoundTrip,
  type BacktestOrderIntent,
  type Candle,
  type PaperFillPolicy,
  type PaperOrder,
} from "@/index";

const INTENT: BacktestOrderIntent = {
  intentId: "btord_sig_p10fixture_EURUSD_1h_long",
  signalId: "sig_p10fixture_EURUSD_1h_2026-09-08T10:00:00.000Z_long",
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

/** EURUSD pip size (registry metadata, not a literal in production paths). */
const PIP = 0.0001;

const POLICY: PaperFillPolicy = {
  policyId: "paper-realistic",
  latencyBars: 1,
  spreadPips: 1,
  slippagePips: 0.5,
  commissionPips: 0.2,
  maxFillFraction: 1,
};

/** 1h-aligned closed bar at 10:00 + `hour` hours. */
function bar(hour: number, o: number, h: number, l: number, c: number): Candle {
  const hh = String(10 + hour).padStart(2, "0");
  return {
    instrument: "EURUSD",
    timeframe: "1h",
    timestamp: `2026-09-08T${hh}:00:00.000Z`,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: null,
  };
}

/** Happy-path cascade: entry on bar 1, target exit on bar 3. */
const BARS_TARGET_EXIT: Candle[] = [
  bar(0, 1.1085, 1.109, 1.108, 1.1088), // submit bar
  bar(1, 1.1086, 1.1089, 1.1084, 1.1087), // market entry fills at OPEN
  bar(2, 1.109, 1.112, 1.1082, 1.1118), // dips to the limit fixture level 1.1082
  bar(3, 1.1118, 1.114, 1.1115, 1.1139), // high 1.1140 >= TP 1.1135
];

function marketOrder(): PaperOrder {
  return paperOrderFromIntent(INTENT, POLICY.latencyBars);
}

function restingOrder(
  entryType: "limit" | "stop",
  entryPrice: number,
): PaperOrder {
  return paperOrderFromIntent({ ...INTENT, entryType, entryPrice }, POLICY.latencyBars);
}

describe("paper fill simulator input guard (P10-02)", () => {
  it("rejects malformed policies, pip sizes and bar cascades (fail closed)", () => {
    expect(() =>
      paperRealisticFill("long", "entry", 1.1, 100, { ...POLICY, spreadPips: -1 }, PIP),
    ).toThrow(/spreadPips/);
    expect(() =>
      paperRealisticFill("long", "entry", 1.1, 100, { ...POLICY, maxFillFraction: 1.5 }, PIP),
    ).toThrow(/maxFillFraction/);
    expect(() => paperRealisticFill("long", "entry", 1.1, 100, POLICY, 0)).toThrow(/pipSize/);
    expect(() => simulateOrderEntryFills(marketOrder(), [], 0, POLICY, PIP)).toThrow(/non-empty/);
    expect(() => simulateOrderEntryFills(marketOrder(), BARS_TARGET_EXIT, -1, POLICY, PIP)).toThrow(
      /submitBarIndex/,
    );
    expect(() =>
      simulateOrderEntryFills(marketOrder(), BARS_TARGET_EXIT, 99, POLICY, PIP),
    ).toThrow(/outside the/);
    expect(() =>
      simulateOrderEntryFills(marketOrder(), BARS_TARGET_EXIT, 0.5, POLICY, PIP),
    ).toThrow(/submitBarIndex/);
  });
});

describe("paper market order fills (P10-02)", () => {
  it("fills at the next bar open with adverse costs, never on the submit bar", () => {
    const sim = simulateOrderEntryFills(marketOrder(), BARS_TARGET_EXIT, 0, POLICY, PIP);
    expect(sim.rejectReason).toBeNull();
    expect(sim.finalState).toBe("filled");
    expect(sim.entryFills).toHaveLength(1);
    const fill = sim.entryFills[0]!;
    expect(fill.side).toBe("entry");
    expect(fill.barIndex).toBe(1);
    expect(fill.atUtc).toBe("2026-09-08T11:00:00.000Z");
    expect(fill.triggerPrice).toBe(1.1086); // bar 1 OPEN
    // long entry buys at ask: open + (half-spread + slippage) = 1.1086 + 1 pip
    expect(fill.price).toBeCloseTo(1.1087, 10);
    expect(fill.costs).toEqual({ spreadPips: 0.5, slippagePips: 0.5, commissionPips: 0.1 });
    expect(fill.quantityUnits).toBe(10000);
    expect(fill.remainingQuantityUnits).toBe(0);
  });

  it("applies the per-bar partial-fill cap against the ORIGINAL request", () => {
    const policy = { ...POLICY, maxFillFraction: 0.5 };
    const sim = simulateOrderEntryFills(marketOrder(), BARS_TARGET_EXIT, 0, policy, PIP);
    expect(sim.entryFills).toHaveLength(2);
    expect(sim.entryFills[0]!.quantityUnits).toBe(5000);
    expect(sim.entryFills[0]!.remainingQuantityUnits).toBe(5000);
    expect(sim.entryFills[1]!.quantityUnits).toBe(5000);
    expect(sim.entryFills[1]!.remainingQuantityUnits).toBe(0);
    expect(sim.finalState).toBe("filled");
  });

  it("short entries sell at bid (adverse cost = minus)", () => {
    const shortIntent: BacktestOrderIntent = {
      ...INTENT,
      direction: "short",
      stopLoss: 1.1115,
      takeProfit: 1.1055,
    };
    const shortBars: Candle[] = [
      bar(0, 1.1085, 1.109, 1.108, 1.1088),
      bar(1, 1.1086, 1.1089, 1.1084, 1.1087),
      bar(2, 1.1084, 1.1086, 1.105, 1.1052), // low <= short TP 1.1055
    ];
    const sim = simulateOrderEntryFills(paperOrderFromIntent(shortIntent, 1), shortBars, 0, POLICY, PIP);
    expect(sim.entryFills[0]!.price).toBeCloseTo(1.1085, 10); // open - 1 pip
  });
});

describe("paper resting limit/stop fills (P10-02)", () => {
  it("long limit fills only when low <= entryPrice, at the resting level", () => {
    // Limit below the market; only bar 2 dips to 1.1082.
    const sim = simulateOrderEntryFills(restingOrder("limit", 1.1082), BARS_TARGET_EXIT, 0, POLICY, PIP);
    expect(sim.finalState).toBe("filled");
    expect(sim.entryFills).toHaveLength(1);
    expect(sim.entryFills[0]!.barIndex).toBe(2);
    expect(sim.entryFills[0]!.triggerPrice).toBe(1.1082);
    expect(sim.entryFills[0]!.price).toBeCloseTo(1.1083, 10); // resting level + adverse
  });

  it("long stop fills when high >= entryPrice; short stop when low <= entryPrice", () => {
    const simLong = simulateOrderEntryFills(restingOrder("stop", 1.1095), BARS_TARGET_EXIT, 0, POLICY, PIP);
    expect(simLong.finalState).toBe("filled"); // bar 2 high 1.1120 crosses 1.1095
    expect(simLong.entryFills[0]!.barIndex).toBe(2);
    expect(simLong.entryFills[0]!.triggerPrice).toBe(1.1095);

    const shortIntent: BacktestOrderIntent = {
      ...INTENT,
      direction: "short",
      stopLoss: 1.1115,
      takeProfit: 1.1055,
    };
    const shortStop = paperOrderFromIntent(
      { ...shortIntent, entryType: "stop", entryPrice: 1.1089 },
      1,
    );
    const shortBars: Candle[] = [
      bar(0, 1.1085, 1.109, 1.108, 1.1088),
      bar(1, 1.1086, 1.1089, 1.1084, 1.1087), // high touches the 1.1089 sell stop
    ];
    const simShort = simulateOrderEntryFills(shortStop, shortBars, 0, POLICY, PIP);
    expect(simShort.finalState).toBe("filled");
    expect(simShort.entryFills[0]!.triggerPrice).toBe(1.1089);
  });

  it("rejects orders without enough post-latency bars (no_latency_bars)", () => {
    const sim = simulateOrderEntryFills(marketOrder(), BARS_TARGET_EXIT, 3, POLICY, PIP);
    expect(sim.rejectReason).toBe("no_latency_bars");
    expect(sim.finalState).toBe("rejected");
    expect(sim.entryFills).toHaveLength(0);
  });

  it("reports expired_before_submit when the submit bar is at/after expiry (boundary)", () => {
    const lateBars: Candle[] = [
      bar(0, 1.1085, 1.109, 1.108, 1.1088),
      bar(1, 1.1086, 1.109, 1.1084, 1.1087),
      bar(2, 1.1086, 1.109, 1.1084, 1.1087),
      bar(3, 1.1086, 1.109, 1.1084, 1.1087),
      bar(4, 1.1086, 1.109, 1.1084, 1.1087), // 14:00 == expiresAtUtc
    ];
    const sanity = simulateOrderEntryFills(marketOrder(), lateBars, 3, POLICY, PIP);
    expect(sanity.rejectReason).toBeNull(); // 13:00 < 14:00 still valid
    const expired = simulateOrderEntryFills(marketOrder(), lateBars, 4, POLICY, PIP);
    expect(expired.rejectReason).toBe("expired_before_submit"); // 14:00 >= 14:00
    expect(expired.finalState).toBe("expired");
  });

  it("expires resting orders that were never touched (expired_unfilled)", () => {
    // The expiry bar (14:00) must be inside the cascade for the expiry path
    // to be observable; before it, an untouched resting order is simply
    // still-live ("partially_filled" — deterministic, no look-ahead).
    const withExpiryBar = [
      ...BARS_TARGET_EXIT,
      bar(4, 1.1135, 1.114, 1.113, 1.1138), // 14:00 — expiry boundary
    ];
    const sim = simulateOrderEntryFills(restingOrder("limit", 1.1075), withExpiryBar, 0, POLICY, PIP);
    expect(sim.rejectReason).toBe("expired_unfilled");
    expect(sim.finalState).toBe("expired");
    expect(sim.entryFills).toHaveLength(0);
  });

  it("stays live (no look-ahead) when the cascade ends before the expiry bar", () => {
    const sim = simulateOrderEntryFills(restingOrder("limit", 1.1075), BARS_TARGET_EXIT, 0, POLICY, PIP);
    expect(sim.rejectReason).toBeNull();
    expect(sim.finalState).toBe("partially_filled");
    expect(sim.entryFills).toHaveLength(0);
  });

  it("is deterministic and idempotent: same inputs -> byte-identical fills", () => {
    const a = simulateOrderEntryFills(marketOrder(), BARS_TARGET_EXIT, 0, POLICY, PIP);
    const b = simulateOrderEntryFills(marketOrder(), BARS_TARGET_EXIT, 0, POLICY, PIP);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("paper round trip with managed exit (P10-02)", () => {
  it("produces the expected fill pair, fees and PnL for the target-exit fixture", () => {
    const rt = simulatePaperRoundTrip(marketOrder(), BARS_TARGET_EXIT, 0, POLICY, PIP);
    expect(rt.abortedReason).toBeNull();
    expect(rt.exitReason).toBe("target");
    expect(rt.entryAvgPrice).toBeCloseTo(1.1087, 10);
    expect(rt.exitFill).not.toBeNull();
    expect(rt.exitFill!.side).toBe("exit");
    expect(rt.exitFill!.triggerPrice).toBe(1.1135);
    expect(rt.exitFill!.price).toBeCloseTo(1.1134, 10); // long exit sells at bid: trigger - 1 pip
    expect(rt.barsConsumed).toBe(4);
    // gross = (1.1134 - 1.1087) * 10000 = 47.0; round-trip commission
    // = (0.1 + 0.1) pips * 0.0001 * 10000 = 0.2 -> realized 46.8
    expect(rt.realizedPnlQuote).toBeCloseTo(46.8, 6);
    // fees = (0.5 + 0.5 + 0.1) pips * 0.0001 * 10000 per side = 1.1 * 2 = 2.2
    expect(rt.feesQuote).toBeCloseTo(2.2, 6);
  });

  it("applies the frozen conservative STOP-FIRST rule when one bar hits both levels", () => {
    const bothHit: Candle[] = [
      BARS_TARGET_EXIT[0]!,
      BARS_TARGET_EXIT[1]!,
      bar(2, 1.1086, 1.114, 1.105, 1.11), // touches BOTH SL 1.1055 and TP 1.1135
    ];
    const rt = simulatePaperRoundTrip(marketOrder(), bothHit, 0, POLICY, PIP);
    expect(rt.exitReason).toBe("stop");
    expect(rt.exitFill!.triggerPrice).toBe(1.1055);
    expect(rt.exitFill!.price).toBeCloseTo(1.1054, 10);
    // gross = (1.1054 - 1.1087) * 10000 = -33 -> realized -33.2
    expect(rt.realizedPnlQuote).toBeCloseTo(-33.2, 6);
  });

  it("falls back to an end_of_simulation exit at the last bar close", () => {
    const quiet: Candle[] = [
      BARS_TARGET_EXIT[0]!,
      BARS_TARGET_EXIT[1]!,
      bar(2, 1.1087, 1.1088, 1.1085, 1.1086), // no stop/target touch
      bar(3, 1.1086, 1.1088, 1.1085, 1.1089),
    ];
    const rt = simulatePaperRoundTrip(marketOrder(), quiet, 0, POLICY, PIP);
    expect(rt.exitReason).toBe("end_of_simulation");
    expect(rt.exitFill!.triggerPrice).toBeCloseTo(1.1089, 10);
    expect(rt.barsConsumed).toBe(4);
  });

  it("aborts the round trip when the entry never fully filled", () => {
    const partial = { ...POLICY, maxFillFraction: 0.5 };
    const twoBars: Candle[] = [BARS_TARGET_EXIT[0]!, BARS_TARGET_EXIT[1]!];
    const sim = simulateOrderEntryFills(marketOrder(), twoBars, 0, partial, PIP);
    expect(sim.finalState).toBe("partially_filled");
    const rt = simulatePaperRoundTrip(marketOrder(), twoBars, 0, partial, PIP);
    expect(rt.abortedReason).toBe("not fully filled");
    expect(rt.exitFill).toBeNull();
    expect(rt.realizedPnlQuote).toBeNull();
  });

  it("round trips are deterministic for deterministic inputs", () => {
    const a = simulatePaperRoundTrip(marketOrder(), BARS_TARGET_EXIT, 0, POLICY, PIP);
    const b = simulatePaperRoundTrip(marketOrder(), BARS_TARGET_EXIT, 0, POLICY, PIP);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
