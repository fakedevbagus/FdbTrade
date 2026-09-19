/**
 * Paper position ledger (P10-03) and reconciliation loop (P10-04) tests.
 *
 * P10-03 acceptance: the ledger reconciles to order/fill fixtures.
 * P10-04 acceptance: reconciliation produces actionable discrepancy reason
 * codes. Deterministic fixtures only; no randomness, no wall clock.
 */
import { describe, expect, it } from "vitest";

import {
  PAPER_DISCREPANCY_CODES,
  applyPaperFill,
  applyPaperOrderTransition,
  createPaperLedger,
  markPaperPositions,
  paperEventIdFor,
  paperBrokerEventSchema,
  paperEquity,
  paperFillContextSchema,
  paperLedgerStateSchema,
  paperOrderFromIntent,
  simulatePaperRoundTrip,
  reconcilePaperBroker,
  verifyPaperLedger,
  type BacktestOrderIntent,
  type Candle,
  type PaperBrokerEvent,
  type PaperFillContext,
  type PaperFillPolicy,
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

const PIP = 0.0001;

const POLICY: PaperFillPolicy = {
  policyId: "paper-realistic",
  latencyBars: 1,
  spreadPips: 1,
  slippagePips: 0.5,
  commissionPips: 0.2,
  maxFillFraction: 1,
};

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

const BARS: Candle[] = [
  bar(0, 1.1085, 1.109, 1.108, 1.1088), // submit
  bar(1, 1.1086, 1.1089, 1.1084, 1.1087), // entry at open
  bar(2, 1.109, 1.112, 1.1082, 1.1118),
  bar(3, 1.1118, 1.114, 1.1115, 1.1139), // target 1.1135 hit
];

const CONVERSION: PaperFillContext["conversion"] = {
  quoteCurrency: "USD",
  accountCurrency: "USD",
  conversionRate: 1,
  rateAtUtc: "2026-09-08T11:00:00.000Z",
  rateSource: "fixture",
};

const CTX: PaperFillContext = paperFillContextSchema.parse({
  pipSize: PIP,
  conversion: CONVERSION,
});

/** The deterministic target-exit round trip shared by every fixture here. */
function roundTrip() {
  return simulatePaperRoundTrip(
    paperOrderFromIntent(INTENT, POLICY.latencyBars),
    BARS,
    0,
    POLICY,
    PIP,
  );
}

function openLedger() {
  const rt = roundTrip();
  const entry = rt.entryFills[0]!;
  return {
    rt,
    entry,
    ledger: applyPaperFill(createPaperLedger("USD", 100000), entry, CTX),
  };
}

function closedLedger() {
  const { rt, ledger } = openLedger();
  return { rt, ledger: applyPaperFill(ledger, rt.exitFill!, CTX) };
}
describe("paper position ledger (P10-03)", () => {
  it("opens a position with VWAP avg price, exposure and per-fill fees", () => {
    const { entry, ledger } = openLedger();
    expect(ledger.positions).toHaveLength(1);
    const pos = ledger.positions[0]!;
    expect(pos.positionId).toBe(`pbpos_${entry.orderId}`);
    expect(pos.status).toBe("open");
    expect(pos.quantityUnits).toBe(10000);
    expect(pos.avgPrice).toBeCloseTo(1.1087, 10);
    expect(pos.openedAtUtc).toBe("2026-09-08T11:00:00.000Z");
    expect(pos.entryFillIds).toEqual([entry.fillId]);
    expect(pos.exitFillIds).toEqual([]);
    // long entry buys: cash debited by notional + fees
    expect(ledger.cash).toBeCloseTo(88911.9, 6); // 100000 - 1.1087*10000 - 1.1
    expect(pos.feesPaidQuote).toBeCloseTo(1.1, 10);
    expect(pos.feesPaidAccount).toBeCloseTo(1.1, 10);
    expect(pos.exposureAccount).toBeCloseTo(1.1087 * 10000, 6);
    expect(pos.conversion).toEqual(CONVERSION);
    expect(ledger.feesTotalAccount).toBeCloseTo(1.1, 10);
    expect(ledger.realizedPnlTotalAccount).toBe(0);
    expect(verifyPaperLedger(ledger)).toEqual([]);
  });

  it("marks positions to market and refreshes equity (cash untouched)", () => {
    const { ledger } = openLedger();
    const marked = markPaperPositions(ledger, "EURUSD", 1.109, CTX);
    const pos = marked.positions[0]!;
    expect(pos.unrealizedPnlQuote).toBeCloseTo(3, 6); // (1.109 - 1.1087) * 10000
    expect(paperEquity(marked)).toBeCloseTo(88914.9, 6);
    expect(marked.cash).toBeCloseTo(ledger.cash, 10);
  });

  it("closes the position on the exit fill and reconciles PnL, fees and cash", () => {
    const { rt, ledger } = closedLedger();
    const pos = ledger.positions[0]!;
    expect(pos.status).toBe("closed");
    expect(pos.closedAtUtc).toBe(rt.exitFill!.atUtc);
    expect(pos.avgPrice).toBeNull();
    expect(pos.exitFillIds).toEqual([rt.exitFill!.fillId]);
    // sell credits cash: 88911.9 + 1.1134*10000 - 1.1 = 100044.8
    expect(ledger.cash).toBeCloseTo(100044.8, 6);
    expect(ledger.realizedPnlTotalAccount).toBeCloseTo(47, 6); // price difference only
    expect(ledger.feesTotalAccount).toBeCloseTo(2.2, 6); // 1.1 per side
    expect(verifyPaperLedger(ledger)).toEqual([]);
  });

  it("records currency conversion metadata on every position (non-unit rate)", () => {
    const eurConversion = { ...CONVERSION, accountCurrency: "EUR", conversionRate: 0.9 };
    const eurCtx = paperFillContextSchema.parse({ pipSize: PIP, conversion: eurConversion });
    const rt = roundTrip();
    const ledger = applyPaperFill(createPaperLedger("EUR", 100000), rt.entryFills[0]!, eurCtx);
    const pos = ledger.positions[0]!;
    expect(pos.feesPaidAccount).toBeCloseTo(1.1 * 0.9, 10);
    expect(pos.exposureAccount).toBeCloseTo(1.1087 * 10000 * 0.9, 6);
    expect(pos.conversion.rateSource).toBe("fixture");
  });

  it("fails closed on impossible balances and malformed input", () => {
    const { rt, ledger } = openLedger();
    // account-currency mismatch
    expect(() =>
      applyPaperFill(ledger, rt.entryFills[0]!, {
        pipSize: PIP,
        conversion: { ...CONVERSION, accountCurrency: "EUR" },
      }),
    ).toThrow(/account currency/i);
    // exit without an open position
    const empty = createPaperLedger("USD", 100000);
    expect(() => applyPaperFill(empty, rt.exitFill!, CTX)).toThrow(/no open/i);
    // closing more than is open (over-close)
    const half = { ...POLICY, maxFillFraction: 0.5 };
    const partialRt = simulatePaperRoundTrip(
      paperOrderFromIntent(INTENT, half.latencyBars),
      [BARS[0]!, BARS[1]!],
      0,
      half,
      PIP,
    );
    const partialEntry = {
      ...partialRt.entryFills[0]!,
      quantityUnits: 5000,
      remainingQuantityUnits: 5000,
    };
    const halfLedger = applyPaperFill(createPaperLedger("USD", 100000), partialEntry, CTX);
    expect(() => applyPaperFill(halfLedger, rt.exitFill!, CTX)).toThrow();
    // malformed money / pip size
    expect(() => createPaperLedger("USD", Number.NaN)).toThrow(/initialCash/i);
    expect(() =>
      applyPaperFill(
        ledger,
        rt.entryFills[0]!,
        paperFillContextSchema.parse({ pipSize: 0, conversion: CONVERSION }),
      ),
    ).toThrow();
  });

  it("detects structurally broken ledgers via verifyPaperLedger (no silent repair)", () => {
    const { ledger } = openLedger();
    const broken = paperLedgerStateSchema.parse({
      ...ledger,
      positions: ledger.positions.map((p) => ({ ...p, avgPrice: null })),
    });
    const problems = verifyPaperLedger(broken);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/no positive avgPrice/);
  });
});

describe("paper order state machine bridge (P10-01 + P10-03)", () => {
  it("drives the frozen lifecycle deterministically through closing", () => {
    const rt = roundTrip();
    let order = applyPaperOrderTransition(
      { orderId: rt.entryFills[0]!.orderId, state: "intent" },
      "risk_checked",
      "2026-09-08T10:00:00.000Z",
    );
    for (const to of ["submitting", "acknowledged", "filled", "managed", "closed"] as const) {
      order = applyPaperOrderTransition(order, to, "2026-09-08T13:00:00.000Z");
    }
    expect(order.state).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// P10-04: reconciliation loop
// ---------------------------------------------------------------------------

const ORDER_ID = `pbord_${INTENT.intentId}`;
const POSITION_ID = `pbpos_${ORDER_ID}`;

/** Build a content-addressed event (eventId derived deterministically). */
function ev(partial: Record<string, unknown>): PaperBrokerEvent {
  const candidate = partial as unknown as PaperBrokerEvent;
  return paperBrokerEventSchema.parse({ ...partial, eventId: paperEventIdFor(candidate) });
}

/** Complete happy-path event log for the target-exit round trip. */
function happyEvents(): PaperBrokerEvent[] {
  const rt = roundTrip();
  const entry = rt.entryFills[0]!;
  const exit = rt.exitFill!;
  const fillEvent = (fill: typeof entry, atUtc: string) =>
    ev({
      type: "fill_executed",
      atUtc,
      orderId: ORDER_ID,
      fillId: fill.fillId,
      side: fill.side,
      quantityUnits: fill.quantityUnits,
      price: fill.price,
      costs: fill.costs,
      remainingQuantityUnits: fill.remainingQuantityUnits,
    });
  return [
    ev({ type: "order_created", atUtc: "2026-09-08T10:00:00.000Z", orderId: ORDER_ID }),
    ev({ type: "order_risk_checked", atUtc: "2026-09-08T10:00:00.000Z", orderId: ORDER_ID }),
    ev({ type: "order_submitted", atUtc: "2026-09-08T10:00:00.000Z", orderId: ORDER_ID }),
    ev({
      type: "order_acknowledged",
      atUtc: "2026-09-08T10:00:00.000Z",
      orderId: ORDER_ID,
      resting: false,
    }),
    fillEvent(entry, "2026-09-08T11:00:00.000Z"),
    ev({
      type: "position_opened",
      atUtc: "2026-09-08T11:00:00.000Z",
      positionId: POSITION_ID,
      orderId: ORDER_ID,
    }),
    ev({ type: "position_managed", atUtc: "2026-09-08T11:00:00.000Z", positionId: POSITION_ID }),
    fillEvent(exit, "2026-09-08T13:00:00.000Z"),
    ev({
      type: "position_closed",
      atUtc: "2026-09-08T13:00:00.000Z",
      positionId: POSITION_ID,
      exitPrice: exit.price,
      exitReason: "target",
      realizedPnl: rt.realizedPnlQuote!,
    }),
  ];
}

/** Fully consistent reconciliation input (events, fills, ledger, contexts). */
function happyInput() {
  const { rt, ledger } = closedLedger();
  const input = {
    events: happyEvents(),
    derivedFills: [rt.entryFills[0]!, rt.exitFill!],
    derivedLedger: ledger,
    fillContexts: { [rt.entryFills[0]!.fillId]: CTX, [rt.exitFill!.fillId]: CTX } as Record<
      string,
      PaperFillContext
    >,
    atUtc: "2026-09-08T13:00:00.000Z",
  };
  return { rt, input };
}

describe("paper reconciliation loop (P10-04)", () => {
  it("produces a clean report for consistent derived state (empty boundary case)", () => {
    const report = reconcilePaperBroker({
      events: [],
      derivedFills: [],
      derivedLedger: createPaperLedger("USD", 100000),
      fillContexts: {},
      atUtc: "2026-09-08T10:00:00.000Z",
    });
    expect(report.ok).toBe(true);
    expect(report.discrepancies).toEqual([]);
    expect(report.eventCount).toBe(0);
  });

  it("reconciles the full happy path with zero discrepancies, deterministically", () => {
    const { input } = happyInput();
    const a = reconcilePaperBroker(input);
    const b = reconcilePaperBroker(input);
    expect(a.ok).toBe(true);
    expect(a.discrepancies).toEqual([]);
    expect(a.eventCount).toBe(input.events.length);
    expect(a.fillCount).toBe(2);
    expect(a.positionCount).toBe(1);
    expect(a.reconciliationId).toMatch(/^pbrec_[0-9a-f]{16}$/);
    expect(a).toEqual(b); // deterministic + idempotent
  });

  it("detects duplicate events via content-addressed ids", () => {
    const { input } = happyInput();
    const duplicate = input.events[0]!;
    const report = reconcilePaperBroker({ ...input, events: [...input.events, duplicate] });
    expect(report.ok).toBe(false);
    expect(report.discrepancies.map((d) => d.code)).toContain("duplicate_event");
  });
});

describe("paper reconciliation discrepancy codes (P10-04)", () => {
  it("detects unknown orders, unknown positions and out-of-order events", () => {
    const { input } = happyInput();
    const late = [
      ev({ type: "order_submitted", atUtc: "2026-09-08T09:00:00.000Z", orderId: "pbord_ghost.1" }),
      ev({
        type: "position_managed",
        atUtc: "2026-09-08T14:00:00.000Z",
        positionId: "pbpos_ghost.1",
      }),
    ];
    const report = reconcilePaperBroker({ ...input, events: [...input.events, ...late] });
    const codes = report.discrepancies.map((d) => d.code);
    expect(codes).toContain("unknown_order");
    expect(codes).toContain("unknown_position");
    expect(codes).toContain("out_of_order_events"); // 09:00 event appended last
    for (const d of report.discrepancies) {
      expect(PAPER_DISCREPANCY_CODES).toContain(d.code); // reason codes exhaustive
    }
  });

  it("flags illegal transitions from the frozen state machine", () => {
    const { input } = happyInput();
    // position_closed after the order is already closed: terminal, absorbing.
    const extra = ev({
      type: "position_closed",
      atUtc: "2026-09-08T14:00:00.000Z",
      positionId: POSITION_ID,
      exitPrice: 1.1134,
      exitReason: "stop",
      realizedPnl: 0,
    });
    const report = reconcilePaperBroker({ ...input, events: [...input.events, extra] });
    expect(report.ok).toBe(false);
    expect(report.discrepancies.map((d) => d.code)).toContain("illegal_transition");
  });

  it("detects missing fills (event without record) and phantom fills (record without event)", () => {
    const { rt, input } = happyInput();
    const withGhostFill = reconcilePaperBroker({
      ...input,
      events: [
        ...input.events,
        ev({
          type: "fill_executed",
          atUtc: "2026-09-08T14:00:00.000Z",
          orderId: ORDER_ID,
          fillId: `pbfill_${"0".repeat(16)}`,
          side: "exit",
          quantityUnits: 1,
          price: 1.11,
          costs: { spreadPips: 0, slippagePips: 0, commissionPips: 0 },
          remainingQuantityUnits: 0,
        }),
      ],
    });
    expect(withGhostFill.discrepancies.map((d) => d.code)).toContain("missing_fill");

    const withoutExitEvent = reconcilePaperBroker({
      ...input,
      // Both fill records exist, but the exit fill_executed event is gone.
      events: input.events.filter(
        (e) => !(e.type === "fill_executed" && e.fillId === rt.exitFill!.fillId),
      ),
    });
    expect(withoutExitEvent.ok).toBe(false);
    expect(withoutExitEvent.discrepancies.map((d) => d.code)).toContain("phantom_fill");
  });

  it("flags state mismatch when events and the ledger disagree on the lifecycle", () => {
    const { input } = happyInput();
    const { ledger: open } = openLedger(); // position still open
    const report = reconcilePaperBroker({ ...input, derivedLedger: open });
    expect(report.ok).toBe(false);
    expect(report.discrepancies.map((d) => d.code)).toContain("state_mismatch");
  });

  it("reports impossible balances without repairing them", () => {
    const { input } = happyInput();
    const { ledger: open } = openLedger(); // position still open...
    const broken = paperLedgerStateSchema.parse({
      ...open,
      // ...but structurally broken: an open position without an avg price.
      positions: open.positions.map((p) => ({ ...p, avgPrice: null })),
    });
    const report = reconcilePaperBroker({ ...input, derivedLedger: broken });
    expect(report.ok).toBe(false);
    const balance = report.discrepancies.filter((d) => d.code === "impossible_balance");
    expect(balance).toHaveLength(1);
    expect(balance[0]!.message).toMatch(/no positive avgPrice/);
    // No repair: the input ledger object is returned untouched by the loop.
    expect(broken.positions[0]!.avgPrice).toBeNull();
  });

  it("detects cash drift when derived state and replay disagree", () => {
    const { input } = happyInput();
    const drifted = paperLedgerStateSchema.parse({
      ...input.derivedLedger,
      cash: input.derivedLedger.cash + 5,
    });
    const report = reconcilePaperBroker({ ...input, derivedLedger: drifted });
    expect(report.ok).toBe(false);
    const drift = report.discrepancies.filter((d) => d.code === "drift");
    expect(drift.length).toBeGreaterThan(0);
    expect(drift[0]!.message).toMatch(/cash drift/);
  });

  it("fails closed on malformed reconciliation input", () => {
    const { input } = happyInput();
    expect(() => reconcilePaperBroker({ ...input, atUtc: "not-a-timestamp" })).toThrow();
    expect(() =>
      reconcilePaperBroker({
        ...input,
        events: [{ type: "bogus" } as unknown as PaperBrokerEvent],
      }),
    ).toThrow();
    // Unused fill contexts are inert, not an error.
    expect(() =>
      reconcilePaperBroker({
        ...input,
        fillContexts: { unknown: CTX, ...input.fillContexts },
      }),
    ).not.toThrow();
  });
});

