/**
 * Event-driven backtest engine (P08-01, ADR-0019).
 *
 * Deterministic bar-by-bar replay over CLOSED canonical candles:
 *
 *   for each closed bar i (after warmup):
 *     1. expire intents whose signal deadline passed (P05-06 semantics)
 *     2. fill pending market/stop/limit entries (fill policy)
 *     3. process open-position exits (stop-first conservative rule)
 *     4. update MFE/MAE from this bar's high/low
 *     5. mark equity (realized + unrealized at this bar's close)
 *     6. evaluate the subject over candles [0..i] (no look-ahead by
 *        construction — the subject never sees bar i+1)
 *
 * Event ordering within one bar is FIXED (expiry -> entry fills -> exits
 * -> mark -> subject) and part of the frozen contract — any change is a
 * breaking change for golden fixtures (P08-04).
 *
 * The subject interface is a pure adapter around the canonical `Strategy`
 * interface: same closed-world snapshot semantics as the P7 pipeline
 * (ADR-0017). The engine NEVER calls an execution layer, reads no clock, uses no
 * randomness (ADR-0003/0005). Same candles + config + subject ->
 * byte-identical result (pinned by tests).
 *
 * Fill policy (P08-01 = `next-bar-open` placeholder, ZERO COSTS):
 * - market intents fill at the open of bar eventTime + latencyBars, full
 *   quantity, zero costs; a position is open only after the fill bar.
 * - stop/limit intents rest until the FIRST closed bar whose range touches
 *   the level (stop: >= level for long entries... mirrored for short;
 *   limit: <= level for long entries... mirrored), else expire at the
 *   signal deadline. Fill price = the resting level (zero slippage).
 * - exits: stop fill at the stop level, target fill at the target level;
 *   when one bar touches both, the STOP fills first (conservative).
 *
 * Session gaps / weekends: the dataset is the closed bar series itself;
 * gaps are just absent bars (ADR-0010) — no bars are invented.
 */
import {
  type BacktestDatasetRef,
  type BacktestEquityPoint,
  type BacktestEvent,
  type BacktestOrderIntent,
  BACKTEST_ENGINE_ID,
  BACKTEST_ENGINE_VERSION,
  type BacktestFinalState,
  type BacktestPosition,
  type BacktestResult,
  type BacktestRunConfig,
  ZERO_COST_BREAKDOWN,
  backtestPositionIdFor,
  type Candle,
  TIMEFRAME_MS,
  backtestOrderIntentSchema,
  backtestResultSchema,
  backtestRunConfigSchema,
  getInstrument,
  serializeBacktestConfigCanonical,
  serializeCandlesCanonical,
} from "@fdbtrade/contracts";
import { createHash } from "node:crypto";

/** The simulated subject: pure, deterministic, closed-world input. */
export interface BacktestSubject {
  readonly id: string;
  readonly version: string;
  readonly configVersion: string;
  /**
   * Evaluate at closed bar `i`. `candles` is the slice [0..i] (a defensive
   * copy each bar — the subject CANNOT look ahead even if it tried). Returns
   * zero or one intent (at most one entry intent per bar, mirroring the
   * canonical one-signal-per-bar strategy rule).
   */
  evaluate(candles: readonly Candle[], barIndex: number): BacktestOrderIntent | null;
}

/** Structural validation errors are engine bugs, not data errors. */
export class BacktestEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BacktestEngineError";
  }
}

/** Parse + validate the run config (fail closed on any malformed field). */
export function assertRunConfig(config: BacktestRunConfig): BacktestRunConfig {
  return backtestRunConfigSchema.parse(config);
}

/** Validate the candle series for one run (homogeneous, ascending, in-period). */
function validateCandles(
  candles: readonly Candle[],
  config: BacktestRunConfig,
): void {
  if (candles.length === 0) {
    throw new BacktestEngineError("backtest requires at least one candle");
  }
  const first = candles[0];
  const last = candles[candles.length - 1];
  for (const c of candles) {
    if (c.instrument !== config.instrument || c.timeframe !== config.timeframe) {
      throw new BacktestEngineError(
        `candle series must be homogeneous (${config.instrument}/${config.timeframe})`,
      );
    }
  }
  for (let i = 1; i < candles.length; i += 1) {
    if (!(candles[i - 1].timestamp < candles[i].timestamp)) {
      throw new BacktestEngineError("candles must be strictly ascending by open time");
    }
  }
  if (
    first.timestamp < config.periodStartUtc ||
    last.timestamp >= config.periodEndUtc
  ) {
    throw new BacktestEngineError(
      "candles must lie inside [periodStartUtc, periodEndUtc)",
    );
  }
  for (const c of candles) {
    if (Date.parse(c.timestamp) % TIMEFRAME_MS[config.timeframe] !== 0) {
      throw new BacktestEngineError(
        `candle ${c.timestamp} is not aligned to the ${config.timeframe} grid`,
      );
    }
  }
}

/** Deterministic run id: first 16 hex of sha256(config canonical form). */
function runIdFor(config: BacktestRunConfig): string {
  // sha256 helper injected at module level (node:crypto — backend only).
  return `btrun_${sha256Hex(serializeBacktestConfigCanonical(config)).slice(0, 16)}`;
}

/** Dataset digest over the canonical candle serialization (sha256). */
function datasetDigest(candles: readonly Candle[]): string {
  return sha256Hex(serializeCandlesCanonical(candles));
}

/**
 * Intent admission: one position per instrument at a time; one pending
 * intent at a time. New intents from the subject while either exists are
 * REJECTED with a machine-readable reason (event-logged, never silent) and
 * the run continues — mirroring a single-position-per-instrument paper
 * account. (P11 risk engine may tighten this later.)
 */
function admitIntent(
  intent: BacktestOrderIntent,
  openPosition: BacktestPosition | null,
  pending: PendingIntent | null,
): { ok: true } | { ok: false; reason: "position_open" | "intent_pending" } {
  if (openPosition !== null) {
    return { ok: false, reason: "position_open" };
  }
  if (pending !== null) {
    return { ok: false, reason: "intent_pending" };
  }
  return { ok: true };
}

/** A resting intent awaiting its fill bar (market latency or stop/limit). */
interface PendingIntent {
  readonly intent: BacktestOrderIntent;
  /** For market intents: the bar index at which the fill happens. */
  readonly fillAtBarIndex: number;
  /** For stop/limit intents: filled when a bar range touches the level. */
  readonly resting: boolean;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Run the backtest. Pure: same candles + config + subject -> byte-identical
 * `BacktestResult` (validated against the strict contract on return).
 *
 * The subject is evaluated AFTER the bar is marked (fixed order, part of the
 * frozen contract) — its intent for the NEXT bar's events is derived from
 * information closed at bar i (no look-ahead, proven by tests).
 */
export function runBacktest(
  candles: readonly Candle[],
  configInput: BacktestRunConfig,
  subject: BacktestSubject,
): BacktestResult {
  const config = assertRunConfig(configInput);
  validateCandles(candles, config);
  if (config.fillPolicy.policyId !== "next-bar-open") {
    throw new BacktestEngineError(
      `fill policy ${config.fillPolicy.policyId} is not implemented by this engine version (P08-01: next-bar-open only)`,
    );
  }

  const frameMs = TIMEFRAME_MS[config.timeframe];
  const events: BacktestEvent[] = [];
  const positions: BacktestPosition[] = [];
  const equityCurve: BacktestEquityPoint[] = [];

  let openPosition: BacktestPosition | null = null;
  let pending: PendingIntent | null = null;
  let realized = 0;
  let closedTrades = 0;

  const barOpen = (i: number): string => candles[i].timestamp;

  const openPositionFromIntent = (
    intent: BacktestOrderIntent,
    fillBarIndex: number,
    fillPrice: number,
  ): BacktestPosition => {
    const atUtc = barOpen(fillBarIndex);
    const position: BacktestPosition = {
      positionId: backtestPositionIdFor(intent.intentId),
      intentId: intent.intentId,
      instrument: intent.instrument,
      timeframe: intent.timeframe,
      direction: intent.direction,
      quantityUnits: intent.quantityUnits,
      entry: { atUtc, price: fillPrice, costs: { ...ZERO_COST_BREAKDOWN } },
      stopLoss: intent.stopLoss,
      takeProfit: intent.takeProfit,
      status: "open",
      exit: null,
      realizedPnl: 0,
      mfePips: 0,
      maePips: 0,
    };
    positions.push(position);
    events.push({ type: "position_opened", atUtc, positionId: position.positionId });
    return position;
  };

  const closePosition = (
    position: BacktestPosition,
    exitBarIndex: number,
    exitPrice: number,
    reason: "stop" | "target" | "end_of_run",
  ): void => {
    const atUtc = barOpen(exitBarIndex);
    const pnl =
      position.direction === "long"
        ? (exitPrice - position.entry.price) * position.quantityUnits
        : (position.entry.price - exitPrice) * position.quantityUnits;
    position.exit = { atUtc, price: exitPrice, reason, costs: { ...ZERO_COST_BREAKDOWN } };
    position.status = "closed";
    position.realizedPnl = pnl;
    realized += pnl;
    closedTrades += 1;
    openPosition = null;
    events.push({ type: "position_exited", atUtc, positionId: position.positionId, reason });
  };

  const updateExcursions = (position: BacktestPosition, bar: Candle): void => {
    const fav =
      position.direction === "long" ? bar.high - position.entry.price : position.entry.price - bar.low;
    const adv =
      position.direction === "long" ? position.entry.price - bar.low : bar.high - position.entry.price;
    if (fav > 0 && fav / pipSizeOf(config) > position.mfePips) {
      position.mfePips = Number((fav / pipSizeOf(config)).toFixed(6));
    }
    if (adv > 0 && adv / pipSizeOf(config) > position.maePips) {
      position.maePips = Number((adv / pipSizeOf(config)).toFixed(6));
    }
  };

  const stopsTouched = (position: BacktestPosition, bar: Candle): boolean =>
    bar.high >= position.stopLoss && bar.low <= position.stopLoss;
  const targetTouched = (position: BacktestPosition, bar: Candle): boolean =>
    position.takeProfit !== null && bar.high >= position.takeProfit && bar.low <= position.takeProfit;

  for (let i = 0; i < candles.length; i += 1) {
    const bar = candles[i];
    const atUtc = barOpen(i);

    // (1) Intent expiry (first closed bar whose open >= expiresAtUtc).
    if (pending !== null && atUtc >= pending.intent.expiresAtUtc) {
      events.push({ type: "intent_expired", atUtc, intentId: pending.intent.intentId });
      pending = null;
    }

    // (2) Entry fills.
    if (pending !== null && openPosition === null) {
      if (!pending.resting && i >= pending.fillAtBarIndex) {
        openPosition = openPositionFromIntent(pending.intent, i, bar.open);
        pending = null;
      } else if (pending.resting && pending.intent.entryPrice !== null) {
        const level = pending.intent.entryPrice;
        // A stop entry triggers when price trades THROUGH the level in the
        // entry direction; a limit entry when price trades back TO it.
        const touched =
          pending.intent.entryType === "stop"
            ? pending.intent.direction === "long"
              ? bar.high >= level
              : bar.low <= level
            : pending.intent.direction === "long"
              ? bar.low <= level
              : bar.high >= level;
        if (touched) {
          openPosition = openPositionFromIntent(pending.intent, i, level);
          pending = null;
        }
      }
    }

    // (3) Exits (stop-first conservative rule).
    if (openPosition !== null) {
      const pos = openPosition;
      if (stopsTouched(pos, bar)) {
        closePosition(pos, i, pos.stopLoss, "stop");
      } else if (targetTouched(pos, bar)) {
        closePosition(pos, i, pos.takeProfit!, "target");
      }
    }

    // (4) MFE/MAE update (bar high/low while open).
    if (openPosition !== null) {
      updateExcursions(openPosition, bar);
    }

    // (5) Mark-to-market at this bar's close.
    const unrealized =
      openPosition === null
        ? 0
        : openPosition.direction === "long"
          ? (bar.close - openPosition.entry.price) * openPosition.quantityUnits
          : (openPosition.entry.price - bar.close) * openPosition.quantityUnits;
    const equity = config.initialEquity + realized + unrealized;
    equityCurve.push({
      barOpenUtc: atUtc,
      equity: Number(equity.toFixed(6)),
      realizedPnl: Number(realized.toFixed(6)),
      unrealizedPnl: Number(unrealized.toFixed(6)),
      openPositions: openPosition === null ? 0 : 1,
    });
    events.push({ type: "equity_marked", atUtc, equity: Number(equity.toFixed(6)) });

    // (6) Subject evaluation over [0..i] (warmup honored; no look-ahead).
    if (i >= config.warmupBars) {
      const slice = candles.slice(0, i + 1);
      const intent = subject.evaluate(slice, i);
      if (intent !== null) {
        const validated = backtestOrderIntentSchema.parse(intent);
        const admitted = admitIntent(validated, openPosition, pending);
        if (admitted.ok) {
          const fillAtBarIndex = i + config.fillPolicy.latencyBars;
          pending = {
            intent: validated,
            fillAtBarIndex,
            resting: validated.entryType !== "market",
          };
          events.push({ type: "intent_submitted", atUtc, intentId: validated.intentId });
        } else {
          events.push({
            type: "intent_rejected",
            atUtc,
            intentId: validated.intentId,
            reason: admitted.reason,
          });
        }
      }
    }
  }

  // End of run: an open position is force-closed at the last bar close
  // (`end_of_run`) so the final equity is fully realized — an honest,
  // explicit event, never a silent drop.
  if (openPosition !== null) {
    const lastBar = candles[candles.length - 1];
    const atUtc = lastBar.timestamp;
    const pnl =
      openPosition.direction === "long"
        ? (lastBar.close - openPosition.entry.price) * openPosition.quantityUnits
        : (openPosition.entry.price - lastBar.close) * openPosition.quantityUnits;
    openPosition.exit = {
      atUtc,
      price: lastBar.close,
      reason: "end_of_run",
      costs: { ...ZERO_COST_BREAKDOWN },
    };
    openPosition.status = "closed";
    openPosition.realizedPnl = pnl;
    realized += pnl;
    closedTrades += 1;
    events.push({
      type: "position_exited",
      atUtc,
      positionId: openPosition.positionId,
      reason: "end_of_run",
    });
    // The forced close happens AFTER the last equity mark — the last curve
    // point still shows the open mark; the final state reports realized.
    openPosition = null;
  }

  positions.sort((a, b) =>
    a.entry.atUtc === b.entry.atUtc
      ? a.positionId < b.positionId
        ? -1
        : 1
      : a.entry.atUtc < b.entry.atUtc
        ? -1
        : 1,
  );

  const dataset: BacktestDatasetRef = {
    datasetId: [
      "dataset",
      "backtest-inline",
      config.instrument,
      config.timeframe,
      candles[0].timestamp,
      new Date(Date.parse(candles[candles.length - 1].timestamp) + frameMs).toISOString(),
    ].join("|"),
    digest: datasetDigest(candles),
  };

  const finalState: BacktestFinalState = {
    equity: Number((config.initialEquity + realized).toFixed(6)),
    realizedPnl: Number(realized.toFixed(6)),
    unrealizedPnl: 0,
    openPositionIds: [],
    pendingIntentIds: pending === null ? [] : [pending.intent.intentId],
    closedTrades,
  };

  const result: BacktestResult = {
    runId: runIdFor(config),
    engineId: BACKTEST_ENGINE_ID,
    engineVersion: BACKTEST_ENGINE_VERSION,
    config,
    dataset,
    bars: {
      consumed: candles.length,
      firstBarOpenUtc: candles[0].timestamp,
      lastBarOpenUtc: candles[candles.length - 1].timestamp,
    },
    events,
    positions,
    equityCurve,
    finalState,
  };
  return backtestResultSchema.parse(result);
}

/** Pip size of the run instrument (registry metadata — never a literal). */
function pipSizeOf(config: BacktestRunConfig): number {
  return getInstrument(config.instrument).precision.pip;
}
