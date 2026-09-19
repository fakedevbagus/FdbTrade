/**
 * Attribution and regime analytics (P12-04, ADR-0023).
 *
 * Attribute closed-trade performance to strategy components, regime,
 * session, direction, symbol and portfolio factors. Semantics frozen:
 *
 * - Attribution is EXCLUSIVE per dimension: every trade contributes its
 *   realizedPnl to EXACTLY ONE group per dimension, so each dimension's
 *   groups sum to the aggregate PnL (no double-counting — pinned by a
 *   reconciliation check inside the report and by tests).
 * - Dimensions (frozen set): strategy, strategyVersion, regime, session,
 *   direction, instrument (symbol), and `portfolioFactor` (an optional
 *   caller-recorded tag such as a session bucket or exposure regime — null
 *   groups as `unattributed`). A portfolio factor is data recorded at trade
 *   time, never invented here.
 * - Session is derived from the entry time's UTC hour via the FROZEN
 *   fx-session convention (asia 00:00-07:00, london 07:00-12:00,
 *   overlap 12:00-16:00, newyork 16:00-21:00, offhours 21:00-24:00,
 *   upper-exclusive). It is a UTC-hour bucketing convention for analytics,
 *   NOT provider session metadata (constitution keeps true session
 *   semantics in market-data metadata; the analytics layer only labels).
 * - Every group carries expectancy/R/win-rate plus its PnL share so
 *   components can be ranked by contribution. The report embeds the
 *   reconciliation: total attributed PnL per dimension vs the aggregate
 *   `totalPnl`, within `tolerance` (default 1e-6, the money-storage scale).
 * - Deterministic for deterministic inputs; UTC timestamps; no broker
 *   access; no automatic strategy changes (non-goal pinned).
 */
import { z } from "zod";

import { AnalyticsError, analyticsTradeFilterSchema, analyticsTradeRecordSchema, tradeRecordMatchesFilter, type AnalyticsTradeFilter, type AnalyticsTradeRecord } from "./outcome";
import { analyticsRound6 } from "./util";

export const ANALYTICS_ATTRIBUTION_VERSION = "1.0.0";

/** Default PnL reconciliation tolerance (money is stored at 6 decimals). */
export const DEFAULT_ATTRIBUTION_TOLERANCE = 1e-6;

/** Frozen UTC-hour session buckets (analytics labels, not market metadata). */
export const ANALYTICS_SESSIONS = [
  { session: "asia", startHourUtc: 0, endHourUtc: 7 },
  { session: "london", startHourUtc: 7, endHourUtc: 12 },
  { session: "overlap", startHourUtc: 12, endHourUtc: 16 },
  { session: "newyork", startHourUtc: 16, endHourUtc: 21 },
  { session: "offhours", startHourUtc: 21, endHourUtc: 24 },
] as const;
export type AnalyticsSession = (typeof ANALYTICS_SESSIONS)[number]["session"];
export const analyticsSessionSchema = z.enum(["asia", "london", "overlap", "newyork", "offhours"]);

/** Session label for a UTC instant (hour-based, upper-exclusive windows). */
export function sessionForUtc(instant: string): AnalyticsSession {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) {
    throw new AnalyticsError(`invalid UTC instant: ${instant}`);
  }
  const hour = new Date(ms).getUTCHours();
  const bucket = ANALYTICS_SESSIONS.find((s) => hour >= s.startHourUtc && hour < s.endHourUtc);
  if (bucket === undefined) {
    throw new AnalyticsError(`hour outside session windows: ${hour}`);
  }
  return bucket.session;
}
/** Attribution dimensions (frozen set; extension needs a new ADR). */
export const ANALYTICS_ATTRIBUTION_DIMENSIONS = [
  "strategy",
  "strategyVersion",
  "regime",
  "session",
  "direction",
  "instrument",
  "portfolioFactor",
] as const;
export type AnalyticsAttributionDimension = (typeof ANALYTICS_ATTRIBUTION_DIMENSIONS)[number];
export const analyticsAttributionDimensionSchema = z.enum(ANALYTICS_ATTRIBUTION_DIMENSIONS);

/** A trade's group value on one dimension (exclusive attribution). */
export function attributionGroupValueFor(
  trade: AnalyticsTradeRecord,
  dimension: AnalyticsAttributionDimension,
): string {
  switch (dimension) {
    case "strategy":
      return trade.strategyId;
    case "strategyVersion":
      return `${trade.strategyId}@${trade.strategyVersion}`;
    case "regime":
      return trade.regimeState ?? "unattributed";
    case "session":
      return sessionForUtc(trade.entryAtUtc);
    case "direction":
      return trade.direction;
    case "instrument":
      return trade.instrument;
    case "portfolioFactor":
      return trade.portfolioFactor ?? "unattributed";
  }
}

export const analyticsAttributionGroupSchema = z
  .object({
    dimension: analyticsAttributionDimensionSchema,
    groupValue: z.string().min(1),
    tradeCount: z.number().int().min(0),
    /** Sum of realized PnL in this group (exclusive: no overlap). */
    totalPnl: z.number().finite(),
    /** Share of the aggregate PnL magnitude (may exceed 1 when signs mix). */
    pnlShare: z.number().finite(),
    expectancyPnl: z.number().finite().nullable(),
    /** Mean R over recorded-risk trades (null when none). */
    averageR: z.number().finite().nullable(),
    winCount: z.number().int().min(0),
    lossCount: z.number().int().min(0),
    winRate: z.number().min(0).max(1).nullable(),
  })
  .strict();
export type AnalyticsAttributionGroup = z.infer<typeof analyticsAttributionGroupSchema>;

export const analyticsAttributionSliceSchema = z
  .object({
    dimension: analyticsAttributionDimensionSchema,
    /** Groups sorted by totalPnl DESC, then groupValue ASC (deterministic). */
    groups: z.array(analyticsAttributionGroupSchema),
    /** Sum of group PnLs — must reconcile with the aggregate within tolerance. */
    attributedPnl: z.number().finite(),
    reconciles: z.boolean(),
    /** attributedPnl - totalPnl (recorded, must be within tolerance). */
    reconciliationGap: z.number().finite(),
  })
  .strict();
export type AnalyticsAttributionSlice = z.infer<typeof analyticsAttributionSliceSchema>;

export const analyticsAttributionReportSchema = z
  .object({
    reportId: z.string().min(4),
    layerId: z.literal("trade-analytics"),
    version: z.literal(ANALYTICS_ATTRIBUTION_VERSION),
    filter: analyticsTradeFilterSchema,
    pnlCurrency: z.string().length(3).regex(/^[A-Z]+$/),
    tradeCount: z.number().int().min(0),
    /** Aggregate realized PnL of the filtered set. */
    totalPnl: z.number().finite(),
    /** The tolerance used for reconciliation (recorded). */
    tolerance: z.number().finite().positive(),
    /** Every dimension reconciles within tolerance. */
    reconciles: z.boolean(),
    /** One slice per dimension, in the frozen dimension order. */
    slices: z.array(analyticsAttributionSliceSchema),
  })
  .strict()
  .refine((r) => r.slices.map((s) => s.dimension).every((d, i, all) => all.indexOf(d) === i), {
    message: "each dimension may appear at most once",
  });
export type AnalyticsAttributionReport = z.infer<typeof analyticsAttributionReportSchema>;

/**
 * Compute the attribution report: one exclusive slice per frozen dimension,
 * each reconciling to the aggregate PnL within `tolerance`. Pure and
 * deterministic; mixed currencies and malformed records fail closed.
 */
export function computeAttributionReport(
  trades: readonly AnalyticsTradeRecord[],
  options: {
    filter?: AnalyticsTradeFilter;
    reportId?: string;
    tolerance?: number;
  } = {},
): AnalyticsAttributionReport {
  const filter = analyticsTradeFilterSchema.parse(options.filter ?? {});
  const reportId = options.reportId ?? "attribution-report";
  const tolerance =
    options.tolerance === undefined ? DEFAULT_ATTRIBUTION_TOLERANCE : options.tolerance;
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new AnalyticsError(`tolerance must be finite and > 0: ${tolerance}`);
  }
  const parsed = trades.map((t) => analyticsTradeRecordSchema.parse(t));
  const currencies = new Set(parsed.map((t) => t.pnlCurrency));
  if (currencies.size > 1) {
    throw new AnalyticsError(`mixed pnlCurrency not allowed: ${[...currencies].sort().join(",")}`);
  }
  const selected = parsed.filter((t) => tradeRecordMatchesFilter(t, filter));
  const pnlCurrency = selected[0]?.pnlCurrency ?? "USD";
  const totalPnl = analyticsRound6(selected.reduce((s, t) => s + t.realizedPnl, 0));
  const grossMagnitude = selected.reduce((s, t) => s + Math.abs(t.realizedPnl), 0);

  const slices = ANALYTICS_ATTRIBUTION_DIMENSIONS.map((dimension) => {
    const acc = new Map<
      string,
      {
        tradeCount: number;
        pnlSum: number;
        winCount: number;
        lossCount: number;
        rSum: number;
        rCount: number;
      }
    >();
    for (const t of selected) {
      const gv = attributionGroupValueFor(t, dimension);
      let g = acc.get(gv);
      if (g === undefined) {
        g = { tradeCount: 0, pnlSum: 0, winCount: 0, lossCount: 0, rSum: 0, rCount: 0 };
        acc.set(gv, g);
      }
      g.tradeCount += 1;
      g.pnlSum += t.realizedPnl;
      if (t.realizedPnl > 0) g.winCount += 1;
      else if (t.realizedPnl < 0) g.lossCount += 1;
      if (t.rMultiple !== null) {
        g.rSum += t.rMultiple;
        g.rCount += 1;
      }
    }
    const decided = (g: { winCount: number; lossCount: number }) => g.winCount + g.lossCount;
    const groups = [...acc.entries()]
      .map(([groupValue, g]) =>
        analyticsAttributionGroupSchema.parse({
          dimension,
          groupValue,
          tradeCount: g.tradeCount,
          totalPnl: analyticsRound6(g.pnlSum),
          pnlShare: grossMagnitude === 0 ? 0 : analyticsRound6(g.pnlSum / grossMagnitude),
          expectancyPnl: g.tradeCount === 0 ? null : analyticsRound6(g.pnlSum / g.tradeCount),
          averageR: g.rCount === 0 ? null : analyticsRound6(g.rSum / g.rCount),
          winCount: g.winCount,
          lossCount: g.lossCount,
          winRate: decided(g) === 0 ? null : analyticsRound6(g.winCount / decided(g)),
        }),
      )
      .sort((a, b) => b.totalPnl - a.totalPnl || (a.groupValue < b.groupValue ? -1 : 1));
    const attributedPnl = analyticsRound6(groups.reduce((s, g) => s + g.totalPnl, 0));
    const gap = analyticsRound6(attributedPnl - totalPnl);
    return analyticsAttributionSliceSchema.parse({
      dimension,
      groups,
      attributedPnl,
      reconciles: Math.abs(gap) <= tolerance,
      reconciliationGap: gap,
    });
  });

  return analyticsAttributionReportSchema.parse({
    reportId,
    layerId: "trade-analytics",
    version: ANALYTICS_ATTRIBUTION_VERSION,
    filter,
    pnlCurrency,
    tradeCount: selected.length,
    totalPnl,
    tolerance,
    reconciles: slices.every((s) => s.reconciles),
    slices,
  });
}

