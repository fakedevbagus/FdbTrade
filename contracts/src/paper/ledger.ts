/**
 * Paper position ledger (P10-03, ADR-0021).
 *
 * A deterministic running account for the paper broker: cash (account
 * currency), positions grouped by instrument + direction, volume-weighted
 * average entry price, realized/unrealized PnL, fees, current exposure and
 * currency-conversion metadata.
 *
 * Semantics frozen here:
 * - PnL is computed in QUOTE currency (price difference * quantity, the same
 *   convention as the P08 engine) and reported alongside its account-currency
 *   conversion. `conversionRate` is quote -> account, recorded per fill with
 *   `rateAtUtc`/`rateSource` metadata (rate data, never a hard-coded literal —
 *   constitution rule).
 * - Spread and slippage are already embedded in each fill's effective price
 *   (P10-02); the ledger records them for fee reporting. Commission is charged
 *   per fill in pips of notional and included in the fee totals.
 * - Fills are applied in order; impossible balances (closing more than open,
 *   negative quantity) fail closed. No wall clock, no randomness; all
 *   timestamps UTC (ADR-0004). The ledger never touches a broker
 *   (ADR-0003/0005).
 */
import { z } from "zod";

import { instrumentIdSchema } from "../marketdata/instrument";
import { utcInstantSchema } from "../marketdata/time";
import { signalDirectionSchema } from "../strategy/contract";
import { round6 } from "./fillSimulator";
import { paperFillSchema, type PaperFill } from "./order";

export const PAPER_LEDGER_ID = "paper-ledger";
export const PAPER_LEDGER_VERSION = "1.0.0";

export class PaperLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaperLedgerError";
  }
}

/** Currency-conversion metadata recorded at each fill (data, never literals). */
export const paperConversionMetadataSchema = z
  .object({
    /** Instrument quote currency (e.g. USD for EURUSD). */
    quoteCurrency: z.string().length(3).regex(/^[A-Z]+$/),
    /** Ledger/account currency (e.g. USD). */
    accountCurrency: z.string().length(3).regex(/^[A-Z]+$/),
    /** quote -> account units, at the fill's recorded instant. */
    conversionRate: z.number().finite().positive(),
    rateAtUtc: utcInstantSchema,
    /** Provenance of the rate (e.g. "fixture"). */
    rateSource: z.string().min(1),
  })
  .strict();

export type PaperConversionMetadata = z.infer<typeof paperConversionMetadataSchema>;

/** Open/closed positions + one mark-to-market book entry. */
export const paperPositionSchema = z
  .object({
    positionId: z.string().regex(/^pbpos_[A-Za-z0-9._:-]+$/),
    instrument: instrumentIdSchema,
    direction: signalDirectionSchema,
    quantityUnits: z.number().finite().nonnegative(),
    /** Volume-weighted average ENTRY price (null once fully closed). */
    avgPrice: z.number().finite().positive().nullable(),
    openedAtUtc: utcInstantSchema,
    closedAtUtc: utcInstantSchema.nullable(),
    status: z.enum(["open", "closed"]),
    /** Accumulated realized PnL of this position, quote ccy (net of commission). */
    realizedPnlQuote: z.number().finite(),
    /** Latest mark-to-market, quote ccy (0 for closed). */
    unrealizedPnlQuote: z.number().finite(),
    /** Fees paid by this position, quote + account ccy. */
    feesPaidQuote: z.number().finite().nonnegative(),
    feesPaidAccount: z.number().finite().nonnegative(),
    /** Current notional (avgPrice * qty) in account ccy (0 for closed). */
    exposureAccount: z.number().finite().nonnegative(),
    /** Latest conversion metadata (last fill/mark applied). */
    conversion: paperConversionMetadataSchema,
    entryFillIds: z.array(z.string().regex(/^pbfill_[0-9a-f]{16}$/)).min(1),
    exitFillIds: z.array(z.string().regex(/^pbfill_[0-9a-f]{16}$/)),
  })
  .strict();

export type PaperPosition = z.infer<typeof paperPositionSchema>;
export const paperLedgerStateSchema = z
  .object({
    accountId: z.literal("paper-account"),
    accountCurrency: z.string().length(3).regex(/^[A-Z]+$/),
    initialCash: z.number().finite(),
    /** Cash balance, account ccy. */
    cash: z.number().finite(),
    positions: z.array(paperPositionSchema).max(256),
    /** Sum of closed-position realized PnL converted to account ccy. */
    realizedPnlTotalAccount: z.number().finite(),
    feesTotalAccount: z.number().finite().nonnegative(),
    /** cash + sum(open unrealized * rate); refreshed by markPaperPositions. */
    equity: z.number().finite(),
  })
  .strict();

export type PaperLedgerState = z.infer<typeof paperLedgerStateSchema>;

/** Per-fill context the ledger needs: pip size (metadata) + conversion rate. */
export const paperFillContextSchema = z
  .object({
    pipSize: z.number().finite().positive(),
    conversion: paperConversionMetadataSchema,
  })
  .strict();

export type PaperFillContext = z.infer<typeof paperFillContextSchema>;

export function createPaperLedger(
  accountCurrency: string,
  initialCash: number,
): PaperLedgerState {
  if (!Number.isFinite(initialCash)) {
    throw new PaperLedgerError(`initialCash must be finite: ${initialCash}`);
  }
  return paperLedgerStateSchema.parse({
    accountId: "paper-account",
    accountCurrency,
    initialCash,
    cash: round6(initialCash),
    positions: [],
    realizedPnlTotalAccount: 0,
    feesTotalAccount: 0,
    equity: round6(initialCash),
  });
}

function positionFeesQuote(fill: PaperFill, pipSize: number): number {
  return (
    (fill.costs.spreadPips + fill.costs.slippagePips + fill.costs.commissionPips) *
    pipSize *
    fill.quantityUnits
  );
}

/**
 * Apply one fill to the ledger (in order). A long position opens with entry
 * buys / closes with exit sells; a short position is the mirror (entry sells
 * credit cash, exit buys debit cash). Impossible balances (closing more than
 * open, negative quantity) fail closed. Returns a NEW ledger state (pure).
 */
export function applyPaperFill(
  ledger: PaperLedgerState,
  fill: PaperFill,
  ctx: PaperFillContext,
): PaperLedgerState {
  const parsedFill = paperFillSchema.parse(fill);
  const parsedCtx = paperFillContextSchema.parse(ctx);
  if (parsedCtx.conversion.accountCurrency !== ledger.accountCurrency) {
    throw new PaperLedgerError(
      `conversion account currency ${parsedCtx.conversion.accountCurrency} != ledger ${ledger.accountCurrency}`,
    );
  }
  const rate = parsedCtx.conversion.conversionRate;
  const qty = parsedFill.quantityUnits;
  const feeQuote = positionFeesQuote(parsedFill, parsedCtx.pipSize);
  const feeAccount = round6(feeQuote * rate);
  const price = parsedFill.price;
  const isLong = parsedFill.direction === "long";

  const positions = ledger.positions.map((p) => ({ ...p }));
  const existing = positions.find(
    (p) =>
      p.instrument === parsedFill.instrument &&
      p.direction === parsedFill.direction &&
      p.status === "open",
  ) ?? null;

  let cash = ledger.cash;
  let realizedTotalAccount = ledger.realizedPnlTotalAccount;
  const feesTotalAccount = round6(ledger.feesTotalAccount + feeAccount);

  if (parsedFill.side === "entry") {
    if (existing === null) {
      positions.push(
        paperPositionSchema.parse({
          positionId: `pbpos_${parsedFill.orderId}`,
          instrument: parsedFill.instrument,
          direction: parsedFill.direction,
          quantityUnits: round6(qty),
          avgPrice: round6(price),
          openedAtUtc: parsedFill.atUtc,
          closedAtUtc: null,
          status: "open",
          realizedPnlQuote: 0,
          unrealizedPnlQuote: 0,
          feesPaidQuote: round6(feeQuote),
          feesPaidAccount: feeAccount,
          exposureAccount: round6(price * qty * rate),
          conversion: parsedCtx.conversion,
          entryFillIds: [parsedFill.fillId],
          exitFillIds: [],
        }),
      );
    } else {
      const total = existing.quantityUnits + qty;
      const avg = (existing.avgPrice! * existing.quantityUnits + price * qty) / total;
      existing.quantityUnits = round6(total);
      existing.avgPrice = round6(avg);
      existing.feesPaidQuote = round6(existing.feesPaidQuote + feeQuote);
      existing.feesPaidAccount = round6(existing.feesPaidAccount + feeAccount);
      existing.exposureAccount = round6(avg * total * rate);
      existing.conversion = parsedCtx.conversion;
      existing.entryFillIds = [...existing.entryFillIds, parsedFill.fillId];
    }
    // Long entry buys spend cash; short entry sells credit cash. Fees always pay.
    cash = isLong
      ? round6(cash - price * qty * rate - feeAccount)
      : round6(cash + price * qty * rate - feeAccount);
    return paperLedgerStateSchema.parse({
      ...ledger,
      cash,
      positions,
      realizedPnlTotalAccount: round6(realizedTotalAccount),
      feesTotalAccount,
      equity: ledger.equity,
    });
  }

  // Exit fill.
  if (existing === null) {
    throw new PaperLedgerError(
      `exit fill ${parsedFill.fillId} has no open ${parsedFill.direction} position for ${parsedFill.instrument}`,
    );
  }
  if (qty > existing.quantityUnits + 1e-9) {
    throw new PaperLedgerError(
      `exit fill ${parsedFill.fillId} closes ${qty} > open ${existing.quantityUnits}`,
    );
  }
  const realizedQuote = round6(
    (isLong ? price - existing.avgPrice! : existing.avgPrice! - price) * qty,
  );
  const newQty = round6(Math.max(0, existing.quantityUnits - qty));
  const closedNow = newQty <= 1e-9;
  existing.quantityUnits = newQty;
  existing.realizedPnlQuote = round6(existing.realizedPnlQuote + realizedQuote);
  existing.feesPaidQuote = round6(existing.feesPaidQuote + feeQuote);
  existing.feesPaidAccount = round6(existing.feesPaidAccount + feeAccount);
  existing.exitFillIds = [...existing.exitFillIds, parsedFill.fillId];
  existing.conversion = parsedCtx.conversion;
  if (closedNow) {
    existing.status = "closed";
    existing.closedAtUtc = parsedFill.atUtc;
    existing.unrealizedPnlQuote = 0;
    existing.exposureAccount = 0;
    existing.avgPrice = null;
    realizedTotalAccount = round6(realizedTotalAccount + realizedQuote * rate);
  } else {
    existing.exposureAccount = round6(existing.avgPrice! * newQty * rate);
  }
  // Long exit sells credit cash; short exit buys spend cash. Fees always pay.
  cash = isLong
    ? round6(cash + price * qty * rate - feeAccount)
    : round6(cash - price * qty * rate - feeAccount);
  return paperLedgerStateSchema.parse({
    ...ledger,
    cash,
    positions,
    realizedPnlTotalAccount: round6(realizedTotalAccount),
    feesTotalAccount,
    equity: ledger.equity,
  });
}

/**
 * Mark every open position of `instrument` to `markPrice` and refresh the
 * ledger equity. Unrealized PnL is quote ccy; exposure is account ccy.
 */
export function markPaperPositions(
  ledger: PaperLedgerState,
  instrument: string,
  markPrice: number,
  ctx: PaperFillContext,
): PaperLedgerState {
  if (!Number.isFinite(markPrice) || markPrice <= 0) {
    throw new PaperLedgerError(`markPrice must be finite and > 0: ${markPrice}`);
  }
  const parsedCtx = paperFillContextSchema.parse(ctx);
  if (parsedCtx.conversion.accountCurrency !== ledger.accountCurrency) {
    throw new PaperLedgerError("conversion account currency must match the ledger");
  }
  const rate = parsedCtx.conversion.conversionRate;
  const positions = ledger.positions.map((p) => {
    if (p.instrument !== instrument || p.status !== "open") return { ...p };
    const unrealized =
      p.direction === "long"
        ? (markPrice - p.avgPrice!) * p.quantityUnits
        : (p.avgPrice! - markPrice) * p.quantityUnits;
    return paperPositionSchema.parse({
      ...p,
      unrealizedPnlQuote: round6(unrealized),
      exposureAccount: round6(p.avgPrice! * p.quantityUnits * rate),
      conversion: parsedCtx.conversion,
    });
  });
  const unrealizedAccount = positions.reduce(
    (acc, p) => (p.status === "open" ? acc + p.unrealizedPnlQuote * rate : acc),
    0,
  );
  return paperLedgerStateSchema.parse({
    ...ledger,
    positions,
    equity: round6(ledger.cash + unrealizedAccount),
  });
}

/** Current ledger equity (cash + open unrealized, account ccy). */
export function paperEquity(ledger: PaperLedgerState): number {
  return paperLedgerStateSchema.parse(ledger).equity;
}

/**
 * Structural sanity: no negative quantity, no non-finite money, closed
 * positions carry zero quantity/exposure. Returns problem codes (used by the
 * P10-04 reconciliation `impossible_balance` check) — never fabricates fixes.
 */
export function verifyPaperLedger(ledger: PaperLedgerState): string[] {
  const problems: string[] = [];
  if (!Number.isFinite(ledger.cash)) problems.push("cash is not finite");
  if (!Number.isFinite(ledger.equity)) problems.push("equity is not finite");
  for (const p of ledger.positions) {
    if (p.quantityUnits < -1e-9) {
      problems.push(`position ${p.positionId} has negative quantity ${p.quantityUnits}`);
    }
    if (p.status === "open" && (p.avgPrice === null || p.avgPrice <= 0)) {
      problems.push(`open position ${p.positionId} has no positive avgPrice`);
    }
    if (p.status === "closed" && p.quantityUnits > 1e-9) {
      problems.push(`closed position ${p.positionId} still holds quantity ${p.quantityUnits}`);
    }
    if (p.status === "closed" && p.closedAtUtc === null) {
      problems.push(`closed position ${p.positionId} has no closedAtUtc`);
    }
  }
  return problems;
}