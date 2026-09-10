"""Event-driven backtest engine — Python mirror (P08-01, ADR-0019).

Deterministic bar-by-bar replay, behavioral mirror of
``backend/src/backtest/engine.ts``: same fixed event order per bar (expiry ->
entry fills -> exits -> MFE/MAE -> mark -> subject), same `next-bar-open`
zero-cost placeholder fill policy, same conservative stop-first rule. Pure
stdlib; no clock, no randomness, no broker (ADR-0003/0005). Parity with the
TS engine is pinned by the committed golden fixtures (P08-04).
"""

from __future__ import annotations

import hashlib
from typing import Callable, Mapping, Optional, Sequence

from datacore import DataError, TIMEFRAME_MS, get_instrument
from datacore.parse import parse_candle
from datacore.validate import ms_to_instant
from datacore.manifest import serialize_candles_canonical

from .contract import (
    BACKTEST_ENGINE_ID,
    BACKTEST_ENGINE_VERSION,
    ZERO_COST_BREAKDOWN,
    instant_ms,
    parse_intent,
    parse_run_config,
    position_id_for,
    serialize_config_canonical,
)


class BacktestEngineError(Exception):
    """Structural engine error (caller bug, not data error)."""


#: Subject: returns zero or one intent for the closed bars [0..i].
Subject = Callable[[Sequence[Mapping], int], Optional[Mapping]]


def _validate_candles(candles: Sequence[Mapping], config: Mapping) -> None:
    if not candles:
        raise BacktestEngineError("backtest requires at least one candle")
    for c in candles:
        if c["instrument"] != config["instrument"] or c["timeframe"] != config["timeframe"]:
            raise BacktestEngineError(
                "candle series must be homogeneous "
                f"({config['instrument']}/{config['timeframe']})"
            )
    for i in range(1, len(candles)):
        if not candles[i - 1]["timestamp"] < candles[i]["timestamp"]:
            raise BacktestEngineError("candles must be strictly ascending by open time")
    if (
        candles[0]["timestamp"] < config["periodStartUtc"]
        or candles[-1]["timestamp"] >= config["periodEndUtc"]
    ):
        raise BacktestEngineError("candles must lie inside [periodStartUtc, periodEndUtc)")
    frame_ms = TIMEFRAME_MS[config["timeframe"]]
    for c in candles:
        if instant_ms(c["timestamp"]) % frame_ms != 0:
            raise BacktestEngineError(
                f"candle {c['timestamp']} is not aligned to the {config['timeframe']} grid"
            )


def _round6(value: float) -> float:
    return float(f"{value:.6f}")


def run_backtest(
    candles: Sequence[Mapping],
    config_input: Mapping,
    subject: Subject,
) -> dict:
    """Mirror of the TS ``runBacktest``: same semantics, same event order."""
    config = parse_run_config(config_input)
    parsed_candles = [parse_candle(c) for c in candles]
    _validate_candles(candles, config)
    if config["fillPolicy"]["policyId"] != "next-bar-open":
        raise BacktestEngineError(
            "fill policy " + config["fillPolicy"]["policyId"]
            + " is not implemented by this engine version (P08-01: next-bar-open only)"
        )

    frame_ms = TIMEFRAME_MS[config["timeframe"]]
    pip_size = get_instrument(config["instrument"]).precision.pip
    events: list[dict] = []
    positions: list[dict] = []
    equity_curve: list[dict] = []

    open_position: Optional[dict] = None
    pending: Optional[dict] = None  # {intent, fillAtBarIndex, resting}
    realized = 0.0
    closed_trades = 0

    def open_position_from(intent: Mapping, fill_bar_index: int, fill_price: float) -> dict:
        at = candles[fill_bar_index]["timestamp"]
        pos = {
            "positionId": position_id_for(intent["intentId"]),
            "intentId": intent["intentId"],
            "instrument": intent["instrument"],
            "timeframe": intent["timeframe"],
            "direction": intent["direction"],
            "quantityUnits": intent["quantityUnits"],
            "entry": {"atUtc": at, "price": fill_price, "costs": dict(ZERO_COST_BREAKDOWN)},
            "stopLoss": intent["stopLoss"],
            "takeProfit": intent["takeProfit"],
            "status": "open",
            "exit": None,
            "realizedPnl": 0.0,
            "mfePips": 0.0,
            "maePips": 0.0,
        }
        positions.append(pos)
        events.append({"type": "position_opened", "atUtc": at, "positionId": pos["positionId"]})
        return pos

    def close_position(
        position: dict, exit_bar_index: int, exit_price: float, reason: str
    ) -> None:
        nonlocal realized, closed_trades, open_position
        at = candles[exit_bar_index]["timestamp"]
        if position["direction"] == "long":
            pnl = (exit_price - position["entry"]["price"]) * position["quantityUnits"]
        else:
            pnl = (position["entry"]["price"] - exit_price) * position["quantityUnits"]
        position["exit"] = {
            "atUtc": at,
            "price": exit_price,
            "reason": reason,
            "costs": dict(ZERO_COST_BREAKDOWN),
        }
        position["status"] = "closed"
        position["realizedPnl"] = pnl
        realized += pnl
        closed_trades += 1
        open_position = None
        events.append(
            {
                "type": "position_exited",
                "atUtc": at,
                "positionId": position["positionId"],
                "reason": reason,
            }
        )

    for i, bar in enumerate(candles):
        at = bar["timestamp"]

        # (1) Intent expiry.
        if pending is not None and at >= pending["intent"]["expiresAtUtc"]:
            events.append(
                {"type": "intent_expired", "atUtc": at, "intentId": pending["intent"]["intentId"]}
            )
            pending = None

        # (2) Entry fills.
        if pending is not None and open_position is None:
            if not pending["resting"] and i >= pending["fillAtBarIndex"]:
                open_position = open_position_from(pending["intent"], i, bar["open"])
                pending = None
            elif pending["resting"] and pending["intent"]["entryPrice"] is not None:
                level = pending["intent"]["entryPrice"]
                if pending["intent"]["entryType"] == "stop":
                    touched = (
                        bar["high"] >= level
                        if pending["intent"]["direction"] == "long"
                        else bar["low"] <= level
                    )
                else:
                    touched = (
                        bar["low"] <= level
                        if pending["intent"]["direction"] == "long"
                        else bar["high"] >= level
                    )
                if touched:
                    open_position = open_position_from(pending["intent"], i, level)
                    pending = None

        # (3) Exits (stop-first conservative).
        if open_position is not None:
            pos = open_position
            stop = pos["stopLoss"]
            stop_touched = bar["high"] >= stop and bar["low"] <= stop
            target = pos["takeProfit"]
            target_touched = (
                target is not None and bar["high"] >= target and bar["low"] <= target
            )
            if stop_touched:
                close_position(pos, i, stop, "stop")
            elif target_touched:
                close_position(pos, i, target, "target")

        # (4) MFE/MAE.
        if open_position is not None:
            pos = open_position
            entry_price = pos["entry"]["price"]
            if pos["direction"] == "long":
                fav = bar["high"] - entry_price
                adv = entry_price - bar["low"]
            else:
                fav = entry_price - bar["low"]
                adv = bar["high"] - entry_price
            if fav > 0:
                pos["mfePips"] = max(pos["mfePips"], _round6(fav / pip_size))
            if adv > 0:
                pos["maePips"] = max(pos["maePips"], _round6(adv / pip_size))

        # (5) Mark-to-market.
        if open_position is None:
            unrealized = 0.0
        elif open_position["direction"] == "long":
            unrealized = (
                bar["close"] - open_position["entry"]["price"]
            ) * open_position["quantityUnits"]
        else:
            unrealized = (
                open_position["entry"]["price"] - bar["close"]
            ) * open_position["quantityUnits"]
        equity = config["initialEquity"] + realized + unrealized
        equity_curve.append(
            {
                "barOpenUtc": at,
                "equity": _round6(equity),
                "realizedPnl": _round6(realized),
                "unrealizedPnl": _round6(unrealized),
                "openPositions": 0 if open_position is None else 1,
            }
        )
        events.append({"type": "equity_marked", "atUtc": at, "equity": _round6(equity)})

        # (6) Subject evaluation (closed-world slice [0..i]).
        if i >= config["warmupBars"]:
            slice_ = candles[: i + 1]
            intent = subject(slice_, i)
            if intent is not None:
                validated = parse_intent(intent)
                if open_position is not None:
                    reason = "position_open"
                elif pending is not None:
                    reason = "intent_pending"
                else:
                    reason = None
                if reason is None:
                    pending = {
                        "intent": validated,
                        "fillAtBarIndex": i + config["fillPolicy"]["latencyBars"],
                        "resting": validated["entryType"] != "market",
                    }
                    events.append(
                        {
                            "type": "intent_submitted",
                            "atUtc": at,
                            "intentId": validated["intentId"],
                        }
                    )
                else:
                    events.append(
                        {
                            "type": "intent_rejected",
                            "atUtc": at,
                            "intentId": validated["intentId"],
                            "reason": reason,
                        }
                    )

    # End of run: force-close any open position at the last bar close.
    if open_position is not None:
        close_position(
            open_position, len(candles) - 1, candles[-1]["close"], "end_of_run"
        )

    positions.sort(
        key=lambda p: (p["entry"]["atUtc"], p["positionId"])
    )

    digest = hashlib.sha256(
        serialize_candles_canonical(parsed_candles).encode("utf-8")
    ).hexdigest()
    dataset = {
        "datasetId": "|".join(
            [
                "dataset",
                "backtest-inline",
                config["instrument"],
                config["timeframe"],
                candles[0]["timestamp"],
                ms_to_instant(instant_ms(candles[-1]["timestamp"]) + frame_ms),
            ]
        ),
        "digest": digest,
    }

    run_id = "btrun_" + hashlib.sha256(
        serialize_config_canonical(config).encode("utf-8")
    ).hexdigest()[:16]

    return {
        "runId": run_id,
        "engineId": BACKTEST_ENGINE_ID,
        "engineVersion": BACKTEST_ENGINE_VERSION,
        "config": config,
        "dataset": dataset,
        "bars": {
            "consumed": len(candles),
            "firstBarOpenUtc": candles[0]["timestamp"],
            "lastBarOpenUtc": candles[-1]["timestamp"],
        },
        "events": events,
        "positions": positions,
        "equityCurve": equity_curve,
        "finalState": {
            "equity": _round6(config["initialEquity"] + realized),
            "realizedPnl": _round6(realized),
            "unrealizedPnl": 0.0,
            "openPositionIds": [],
            "pendingIntentIds": [] if pending is None else [pending["intent"]["intentId"]],
            "closedTrades": closed_trades,
        },
    }
