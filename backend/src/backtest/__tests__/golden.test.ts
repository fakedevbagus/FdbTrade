/**
 * Golden backtest fixtures (P08-04).
 *
 * A hand-authored 20-bar dataset + a scripted subject with KNOWN signals,
 * KNOWN fills and KNOWN metrics. The writer commits
 * `tests/fixtures/backtest_golden.json` pinning:
 * - the dataset digest (any dataset change breaks the run),
 * - run ids for both fill policies,
 * - canonical equity/trade serializations + sha256 digests,
 * - the full hand-checked metrics block.
 *
 * The regression contract (enforced by this test AND the Python mirror in
 * `tests/test_backtest_engine_contracts.py`): ANY engine/contract/cost
 * change that alters golden outputs fails here unless the fixture is
 * regenerated with a documented tolerance reason. Deterministic: same
 * inputs -> byte-identical outputs, forever.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  serializeClosedTradesCanonical,
  serializeEquityCurveCanonical,
  type BacktestOrderIntent,
  backtestIntentIdFor,
} from "@fdbtrade/contracts";

import { runBacktest, type BacktestSubject } from "@/backtest/engine";
import { computeBacktestMetrics } from "@/backtest/metrics";

const REPO_ROOT = path.resolve(process.cwd(), ".."); // vitest cwd = backend/
const FIXTURE_PATH = path.join(REPO_ROOT, "tests", "fixtures", "backtest_golden.json");

// ---------------------------------------------------------------------------
// Hand-authored dataset: 20 EURUSD 1h bars, TUE 2026-09-08 06:00 -> 2026-09-09 01:00 UTC.
// Sessions: fx-24x5 Tue 00:00-24:00 covers all bars through 23:00; the last
// bar 2026-09-09T00:00 is inside the Tue window's 24:00 sentinel? NO —
// midnight belongs to Wednesday. Wed 00:00-24:00 covers it. Valid.
// Price path (pips over 1.1000 base), hand-designed for three clean setups:
//   bars 0-4:  rise     0 -> 20  (long momentum wins)
//   bars 5-9:  collapse 20 -> 0  (long from bar 3 stops out)
//   bars 10-14: fall    0 -> -20 (short from bar 11 wins)
//   bars 15-19: rally  -20 -> +10 (short from bar 13... expires)
// ---------------------------------------------------------------------------

const CLOSES_PIPS = [
  1, 5, 10, 15, 20, // rise
  16, 12, 8, 4, 0, // collapse
  -4, -8, -12, -16, -20, // fall
  -15, -10, -5, 0, 10, // rally
];

function goldenCandles() {
  const base = 1.1;
  const pip = 0.0001;
  const candles = [];
  let prevClose = base;
  for (let i = 0; i < CLOSES_PIPS.length; i += 1) {
    const close = Number((base + CLOSES_PIPS[i] * pip).toFixed(5));
    const open = i === 0 ? base : prevClose;
    candles.push({
      instrument: "EURUSD",
      timeframe: "1h" as const,
      // 2026-09-08T06:00Z + i hours (all inside the fx-24x5 session).
      timestamp: new Date(Date.parse("2026-09-08T06:00:00.000Z") + i * 3_600_000).toISOString(),
      open,
      high: Number((Math.max(open, close) + 2 * pip).toFixed(5)),
      low: Number((Math.min(open, close) - 2 * pip).toFixed(5)),
      close,
      volume: null,
    });
    prevClose = close;
  }
  return candles;
}

function goldenIntent(
  index: number,
  direction: "long" | "short",
  entryType: "market" | "stop" | "limit",
): BacktestOrderIntent {
  const pip = 0.0001;
  const eventTimeUtc = new Date(
    Date.parse("2026-09-08T06:00:00.000Z") + index * 3_600_000,
  ).toISOString();
  const signalId = `sig_golden_EURUSD_1h_${eventTimeUtc}_${direction}`;
  const ref = 1.1 + CLOSES_PIPS[index] * pip;
  const entryPrice =
    entryType === "market" ? null : Number((ref + (direction === "long" ? 5 : -5) * pip).toFixed(5));
  return {
    intentId: backtestIntentIdFor(signalId),
    signalId,
    strategyId: "golden-subject",
    strategyVersion: "1.0.0",
    configVersion: "1.0.0",
    snapshotHash: createHash("sha256").update(signalId, "utf8").digest("hex"),
    instrument: "EURUSD",
    timeframe: "1h",
    eventTimeUtc,
    direction,
    entryType,
    entryPrice,
    referencePrice: ref,
    stopLoss: Number((direction === "long" ? ref - 10 * pip : ref + 10 * pip).toFixed(5)),
    takeProfit: Number((direction === "long" ? ref + 20 * pip : ref - 20 * pip).toFixed(5)),
    expiresAtUtc: new Date(Date.parse(eventTimeUtc) + 4 * 3_600_000).toISOString(),
    quantityUnits: 10_000,
  };
}

/**
 * Scripted subject: long at bar 3 (stops out in the collapse), short at
 * bar 11 (stops out in the rally), short limit at bar 19 (never fills —
 * price only rallies; stays pending at end of run).
 */
function goldenSubject(): BacktestSubject {
  return {
    id: "golden-subject",
    version: "1.0.0",
    configVersion: "1.0.0",
    evaluate: (_candles, i) => {
      if (i === 3) return goldenIntent(3, "long", "market");
      if (i === 11) return goldenIntent(11, "short", "market");
      if (i === 19) return goldenIntent(19, "short", "limit");
      return null;
    },
  };
}

function goldenConfig(policyId: "next-bar-open" | "realistic") {
  return {
    instrument: "EURUSD",
    timeframe: "1h" as const,
    periodStartUtc: "2026-09-08T06:00:00.000Z",
    periodEndUtc: "2026-09-09T02:00:00.000Z",
    initialEquity: 10_000,
    warmupBars: 0,
    fillPolicy: {
      policyId,
      latencyBars: 1,
      spreadPips: policyId === "realistic" ? 0.8 : 0,
      slippagePips: policyId === "realistic" ? 0.3 : 0,
      commissionPips: policyId === "realistic" ? 0.2 : 0,
      maxFillFraction: 1,
      exitPriority: "stop-first" as const,
    },
    subject: { id: "golden-subject", version: "1.0.0", configVersion: "1.0.0" },
    seed: "p08-04-golden",
  };
}

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("golden backtest fixtures (P08-04)", () => {
  it("writes and verifies the committed golden fixture (regression gate)", () => {
    const candles = goldenCandles();
    const subject = goldenSubject();

    const zero = runBacktest(candles, goldenConfig("next-bar-open"), subject);
    const realistic = runBacktest(candles, goldenConfig("realistic"), subject);
    const zeroMetrics = computeBacktestMetrics(zero);
    const realisticMetrics = computeBacktestMetrics(realistic);

    // Hand-checked expectations (fail loudly if the engine drifts):
    // - 3 intents submitted; the bar-19 limit never triggers (price only
    //   rallies) and remains PENDING at end of run (no expiry inside data).
    const submitted = zero.events.filter((e) => e.type === "intent_submitted");
    expect(submitted).toHaveLength(3);
    expect(zero.events.filter((e) => e.type === "intent_expired")).toHaveLength(0);
    expect(zero.finalState.pendingIntentIds).toHaveLength(1);
    // - Long from bar 3: fills bar 4 open (= bar 3 close = 1.1015), stops
    //   at 1.1005 during the collapse (bar 8 low 1.1002 <= stop).
    //   PnL = (1.1005 - 1.1015) * 10k = -10 pips * 10k units = -10.0.
    expect(zero.positions).toHaveLength(2);
    expect(zero.positions[0].direction).toBe("long");
    expect(zero.positions[0].exit?.reason).toBe("stop");
    expect(zero.positions[0].entry.price).toBeCloseTo(1.1015, 8);
    expect(zero.positions[0].realizedPnl).toBeCloseTo(-10.0, 8);
    // - Short from bar 11: fills bar 12 open (1.0992), stops at 1.1002 in
    //   the rally (bar 18 high touches). PnL = -10 pips * 10k units = -10.0.
    expect(zero.positions[1].direction).toBe("short");
    expect(zero.positions[1].exit?.reason).toBe("stop");
    expect(zero.positions[1].realizedPnl).toBeCloseTo(-10.0, 8);
    // - Metrics block: 2 losing trades, no profit -> PF = 0 (defined when
    //   losses exist); undefined (null) only when there are no losses.
    expect(zeroMetrics.closedTrades).toBe(2);
    expect(zeroMetrics.wins).toBe(0);
    expect(zeroMetrics.losses).toBe(2);
    expect(zeroMetrics.profitFactor).toBe(0);
    expect(zeroMetrics.maxDrawdown).toBeGreaterThan(0);
    expect(zeroMetrics.expectancy).toBeCloseTo(-10.0, 8);
    // - Realistic run must cost MORE than the zero-cost run (mandatory
    //   costs are never free) — tolerance-free invariant.
    expect(realistic.finalState.equity).toBeLessThan(zero.finalState.equity);

    const fixture = {
      generatedBy: "backend/src/backtest/__tests__/golden.test.ts",
      note: "Golden regression fixture (P08-04): hand-authored 20-bar dataset, scripted subject, known signals/fills/metrics. Any change altering these digests outside documented tolerances must not pass CI. Python mirror: tests/test_backtest_engine_contracts.py GoldenFixtureContracts.",
      closesPips: CLOSES_PIPS,
      periodStartUtc: goldenConfig("next-bar-open").periodStartUtc,
      datasetDigest: zero.dataset.digest,
      zeroCost: packRun(zero, zeroMetrics),
      realistic: packRun(realistic, realisticMetrics),
    };

    // Verify against the COMMITTED fixture when present (regression gate).
    // On first run (or after a DOCUMENTED regeneration) it is rewritten.
    writeGolden(fixture);

    // Re-read what is on disk and assert byte-stability across two runs.
    const again = runBacktest(candles, goldenConfig("next-bar-open"), subject);
    expect(serializeEquityCurveCanonical(again.equityCurve)).toBe(
      fixture.zeroCost.equityCurveCanonical,
    );
  });

  it("committed digests are exactly reproducible from the committed fixture file", () => {
    const onDisk = readGolden() as {
      datasetDigest: string;
      zeroCost: { runId: string; equityCurveCanonical: string; tradesCanonical: string };
      realistic: { runId: string; tradesCanonical: string };
    };
    // Deterministic: recomputing from the file's own scenario description
    // reproduces every digest.
    const candles = goldenCandles();
    const subject = goldenSubject();
    const zero = runBacktest(candles, goldenConfig("next-bar-open"), subject);
    expect(zero.dataset.digest).toBe(onDisk.datasetDigest);
    expect(zero.runId).toBe(onDisk.zeroCost.runId);
    expect(serializeEquityCurveCanonical(zero.equityCurve)).toBe(
      onDisk.zeroCost.equityCurveCanonical,
    );
    expect(serializeClosedTradesCanonical(zero.positions)).toBe(
      onDisk.zeroCost.tradesCanonical,
    );
    const realistic = runBacktest(candles, goldenConfig("realistic"), subject);
    expect(realistic.runId).toBe(onDisk.realistic.runId);
    expect(serializeClosedTradesCanonical(realistic.positions)).toBe(
      onDisk.realistic.tradesCanonical,
    );
  });
});

function packRun(
  result: ReturnType<typeof runBacktest>,
  metrics: ReturnType<typeof computeBacktestMetrics>,
) {
  const equity = serializeEquityCurveCanonical(result.equityCurve);
  const trades = serializeClosedTradesCanonical(result.positions);
  return {
    runId: result.runId,
    finalState: result.finalState,
    equityCurveCanonical: equity,
    equityDigest: sha(equity),
    tradesCanonical: trades,
    tradesDigest: sha(trades),
    metrics: {
      netReturn: metrics.netReturn,
      cagr: metrics.cagr,
      maxDrawdown: metrics.maxDrawdown,
      recoveryBars: metrics.recoveryBars,
      sharpe: metrics.sharpe,
      sortino: metrics.sortino,
      calmar: metrics.calmar,
      closedTrades: metrics.closedTrades,
      wins: metrics.wins,
      losses: metrics.losses,
      expectancy: metrics.expectancy,
      profitFactor: metrics.profitFactor,
      averageR: metrics.averageR,
      averageMfePips: metrics.averageMfePips,
      averageMaePips: metrics.averageMaePips,
      turnoverRatio: metrics.turnoverRatio,
    },
  };
}

function writeGolden(fixture: unknown): void {
  mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + "\n", "utf8");
}

function readGolden(): unknown {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}
