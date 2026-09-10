"""Event-driven backtest contracts — Python mirror (P08-01, ADR-0019).

Stdlib-only mirror of ``contracts/src/backtest/contract.ts``: enums, strict
fail-closed parsers for intents/run configs, deterministic ids and the
canonical serializations used for config/equity/trade hashing. Deterministic
for deterministic inputs; all timestamps UTC (ADR-0004). The engine NEVER
calls a broker (ADR-0003); live execution stays OFF (ADR-0005).
"""

from __future__ import annotations

import re
from typing import Mapping, Sequence

from datacore import (
    DataError,
    TIMEFRAME_MS,
    validate_instrument_id,
    validate_semver,
    validate_utc_instant,
)

#: Identity of the mirrored engine.
BACKTEST_ENGINE_ID = "event-driven-backtest"
BACKTEST_ENGINE_VERSION = "1.0.0"

#: Frozen conservative intra-bar ambiguity rule.
BACKTEST_EXIT_PRIORITIES = ("stop-first",)

#: Frozen intent-rejection reasons.
BACKTEST_INTENT_REJECT_REASONS = ("intent_pending", "position_open")

#: Position close reasons (``end_of_run`` = force-close at last bar close).
BACKTEST_EXIT_REASONS = ("stop", "target", "end_of_run")

#: Frozen engine event types (sorted).
BACKTEST_EVENT_TYPES = (
    "equity_marked",
    "intent_expired",
    "intent_rejected",
    "intent_submitted",
    "position_exited",
    "position_opened",
)

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_STRATEGY_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_INTENT_ID_RE = re.compile(r"^btord_sig_[A-Za-z0-9._:-]+$")
_POSITION_ID_RE = re.compile(r"^btpos_btord_sig_[A-Za-z0-9._:-]+$")
_RUN_ID_RE = re.compile(r"^btrun_[0-9a-f]{16}$")

ZERO_COST_BREAKDOWN = {"spreadPips": 0.0, "slippagePips": 0.0, "commissionPips": 0.0}


def _require_mapping(value: object, what: str) -> dict:
    if not isinstance(value, Mapping):
        raise DataError(f"{what} must be a mapping")
    return dict(value)


def _require_keys(obj: dict, keys: Sequence[str], what: str) -> None:
    unknown = set(obj) - set(keys)
    if unknown:
        raise DataError(f"{what} has unknown keys: {sorted(unknown)}")
    missing = set(keys) - set(obj)
    if missing:
        raise DataError(f"{what} is missing keys: {sorted(missing)}")


def _require_str(obj: dict, key: str, what: str, *, min_len: int = 1) -> str:
    v = obj[key]
    if not isinstance(v, str) or len(v) < min_len:
        raise DataError(f"{what}.{key} must be a string of length >= {min_len}")
    return v


def _require_num(
    obj: dict, key: str, what: str, *, finite: bool = True, minimum: float | None = None,
    maximum: float | None = None, integer: bool = False, exclusive_min: bool = False,
) -> float:
    v = obj[key]
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise DataError(f"{what}.{key} must be a number")
    if finite and v != v or (finite and v in (float("inf"), float("-inf"))):
        raise DataError(f"{what}.{key} must be finite")
    if minimum is not None:
        if exclusive_min and not v > minimum:
            raise DataError(f"{what}.{key} must be > {minimum}: {v!r}")
        if not exclusive_min and not v >= minimum:
            raise DataError(f"{what}.{key} must be >= {minimum}: {v!r}")
    if maximum is not None and not v <= maximum:
        raise DataError(f"{what}.{key} must be <= {maximum}: {v!r}")
    if integer and not float(v).is_integer():
        raise DataError(f"{what}.{key} must be an integer: {v!r}")
    return float(v)


def parse_cost_breakdown(value: object) -> dict:
    obj = _require_mapping(value, "costBreakdown")
    _require_keys(obj, ("spreadPips", "slippagePips", "commissionPips"), "costBreakdown")
    return {
        "spreadPips": _require_num(obj, "spreadPips", "costBreakdown", minimum=0),
        "slippagePips": _require_num(obj, "slippagePips", "costBreakdown", minimum=0),
        "commissionPips": _require_num(obj, "commissionPips", "costBreakdown", minimum=0),
    }



def instant_ms(value: str) -> int:
    """Epoch milliseconds of a canonical UTC instant (datacore helper)."""
    from datacore.validate import instant_to_ms

    return instant_to_ms(value)


def parse_intent(value: object) -> dict:
    """Strict fail-closed mirror of ``backtestOrderIntentSchema``."""
    obj = _require_mapping(value, "intent")
    keys = (
        "intentId", "signalId", "strategyId", "strategyVersion", "configVersion",
        "snapshotHash", "instrument", "timeframe", "eventTimeUtc", "direction",
        "entryType", "entryPrice", "referencePrice", "stopLoss", "takeProfit",
        "expiresAtUtc", "quantityUnits",
    )
    _require_keys(obj, keys, "intent")

    intent_id = _require_str(obj, "intentId", "intent", min_len=4)
    if not _INTENT_ID_RE.match(intent_id):
        raise DataError(f"intentId must be btord_{{signalId}}: {intent_id!r}")
    signal_id = _require_str(obj, "signalId", "intent", min_len=4)
    strategy_id = _require_str(obj, "strategyId", "intent")
    if not _STRATEGY_ID_RE.match(strategy_id):
        raise DataError(f"strategyId must be kebab-case: {strategy_id!r}")
    strategy_version = validate_semver(obj["strategyVersion"], "strategyVersion")
    config_version = validate_semver(obj["configVersion"], "configVersion")
    snapshot_hash = _require_str(obj, "snapshotHash", "intent")
    if not _SHA256_RE.match(snapshot_hash):
        raise DataError("snapshotHash must be lowercase sha256 hex")
    instrument = validate_instrument_id(obj["instrument"])
    timeframe = obj["timeframe"]
    if timeframe not in TIMEFRAME_MS:
        raise DataError(f"unknown timeframe: {timeframe!r}")
    event_time = validate_utc_instant(obj["eventTimeUtc"])
    direction = obj["direction"]
    if direction not in ("long", "short"):
        raise DataError(f"direction must be long|short: {direction!r}")
    entry_type = obj["entryType"]
    if entry_type not in ("market", "stop", "limit"):
        raise DataError(f"entryType must be market|stop|limit: {entry_type!r}")

    entry_price = obj["entryPrice"]
    if entry_price is not None and (not isinstance(entry_price, (int, float)) or entry_price <= 0):
        raise DataError("entryPrice must be a positive number or null")
    reference_price = _require_num(obj, "referencePrice", "intent", exclusive_min=True, minimum=0)
    stop_loss = _require_num(obj, "stopLoss", "intent", exclusive_min=True, minimum=0)
    take_profit = obj["takeProfit"]
    if take_profit is not None and (
        not isinstance(take_profit, (int, float)) or take_profit <= 0
    ):
        raise DataError("takeProfit must be a positive number or null")
    expires_at = validate_utc_instant(obj["expiresAtUtc"])
    quantity = _require_num(obj, "quantityUnits", "intent", exclusive_min=True, minimum=0)

    frame_ms = TIMEFRAME_MS[timeframe]
    if instant_ms(event_time) % frame_ms != 0:
        raise DataError("eventTimeUtc must be aligned to the timeframe grid")
    delta = instant_ms(expires_at) - instant_ms(event_time)
    if delta <= 0 or delta % frame_ms != 0:
        raise DataError("expiresAtUtc must be after eventTimeUtc and grid-aligned")
    if entry_type != "market" and entry_price is None:
        raise DataError("stop/limit intents require an entryPrice")

    ref = entry_price if entry_price is not None else reference_price
    if stop_loss == ref:
        raise DataError("stopLoss must differ from the effective reference")
    if take_profit is not None and take_profit == stop_loss:
        raise DataError("takeProfit must differ from stopLoss")
    if direction == "long":
        if not stop_loss < ref or (take_profit is not None and not take_profit > ref):
            raise DataError("levels must be direction-consistent (long)")
    else:
        if not stop_loss > ref or (take_profit is not None and not take_profit < ref):
            raise DataError("levels must be direction-consistent (short)")

    return {
        "intentId": intent_id,
        "signalId": signal_id,
        "strategyId": strategy_id,
        "strategyVersion": strategy_version,
        "configVersion": config_version,
        "snapshotHash": snapshot_hash,
        "instrument": instrument,
        "timeframe": timeframe,
        "eventTimeUtc": event_time,
        "direction": direction,
        "entryType": entry_type,
        "entryPrice": float(entry_price) if entry_price is not None else None,
        "referencePrice": reference_price,
        "stopLoss": stop_loss,
        "takeProfit": float(take_profit) if take_profit is not None else None,
        "expiresAtUtc": expires_at,
        "quantityUnits": quantity,
    }


def parse_fill_policy(value: object) -> dict:
    """Strict mirror of ``backtestFillPolicySchema``."""
    obj = _require_mapping(value, "fillPolicy")
    _require_keys(
        obj,
        ("policyId", "latencyBars", "spreadPips", "slippagePips", "commissionPips",
         "maxFillFraction", "exitPriority"),
        "fillPolicy",
    )
    policy_id = obj["policyId"]
    if policy_id not in ("next-bar-open", "realistic"):
        raise DataError(f"policyId must be next-bar-open|realistic: {policy_id!r}")
    latency = _require_num(obj, "latencyBars", "fillPolicy", minimum=1, integer=True)
    spread = _require_num(obj, "spreadPips", "fillPolicy", minimum=0)
    slippage = _require_num(obj, "slippagePips", "fillPolicy", minimum=0)
    commission = _require_num(obj, "commissionPips", "fillPolicy", minimum=0)
    max_fraction = _require_num(obj, "maxFillFraction", "fillPolicy", exclusive_min=True, minimum=0, maximum=1)
    exit_priority = obj["exitPriority"]
    if exit_priority not in BACKTEST_EXIT_PRIORITIES:
        raise DataError(f"exitPriority must be stop-first: {exit_priority!r}")
    return {
        "policyId": policy_id,
        "latencyBars": int(latency),
        "spreadPips": spread,
        "slippagePips": slippage,
        "commissionPips": commission,
        "maxFillFraction": max_fraction,
        "exitPriority": exit_priority,
    }


def parse_run_config(value: object) -> dict:
    """Strict mirror of ``backtestRunConfigSchema``."""
    obj = _require_mapping(value, "runConfig")
    _require_keys(
        obj,
        ("instrument", "timeframe", "periodStartUtc", "periodEndUtc", "initialEquity",
         "warmupBars", "fillPolicy", "subject", "seed"),
        "runConfig",
    )
    instrument = validate_instrument_id(obj["instrument"])
    timeframe = obj["timeframe"]
    if timeframe not in TIMEFRAME_MS:
        raise DataError(f"unknown timeframe: {timeframe!r}")
    start = validate_utc_instant(obj["periodStartUtc"])
    end = validate_utc_instant(obj["periodEndUtc"])
    if not start < end:
        raise DataError("periodStartUtc must be before periodEndUtc")
    frame_ms = TIMEFRAME_MS[timeframe]
    if instant_ms(start) % frame_ms != 0 or instant_ms(end) % frame_ms != 0:
        raise DataError("period bounds must be aligned to the timeframe grid")
    equity = _require_num(obj, "initialEquity", "runConfig", exclusive_min=True, minimum=0)
    warmup = _require_num(obj, "warmupBars", "runConfig", minimum=0, integer=True)
    policy = parse_fill_policy(obj["fillPolicy"])
    subject = _require_mapping(obj["subject"], "runConfig.subject")
    _require_keys(subject, ("id", "version", "configVersion"), "runConfig.subject")
    subject = {
        "id": _require_str(subject, "id", "runConfig.subject"),
        "version": validate_semver(subject["version"], "subject.version"),
        "configVersion": validate_semver(subject["configVersion"], "subject.configVersion"),
    }
    seed = _require_str(obj, "seed", "runConfig")
    return {
        "instrument": instrument,
        "timeframe": timeframe,
        "periodStartUtc": start,
        "periodEndUtc": end,
        "initialEquity": equity,
        "warmupBars": int(warmup),
        "fillPolicy": policy,
        "subject": subject,
        "seed": seed,
    }


def intent_id_for(signal_id: str) -> str:
    return f"btord_{signal_id}"


def position_id_for(intent_id: str) -> str:
    return f"btpos_{intent_id}"


def _num(value: float) -> str:
    from datacore.manifest import js_number_str

    return js_number_str(float(value))


def serialize_config_canonical(config: Mapping) -> str:
    """Mirror of ``serializeBacktestConfigCanonical`` (hash input)."""
    p = config["fillPolicy"]
    return "|".join(
        [
            "btcfg",
            config["instrument"],
            config["timeframe"],
            config["periodStartUtc"],
            config["periodEndUtc"],
            _num(config["initialEquity"]),
            _num(config["warmupBars"]),
            p["policyId"],
            _num(p["latencyBars"]),
            _num(p["spreadPips"]),
            _num(p["slippagePips"]),
            _num(p["commissionPips"]),
            _num(p["maxFillFraction"]),
            p["exitPriority"],
            config["subject"]["id"],
            config["subject"]["version"],
            config["subject"]["configVersion"],
            config["seed"],
        ]
    )


def serialize_equity_curve_canonical(points: Sequence[Mapping]) -> str:
    """Mirror of ``serializeEquityCurveCanonical``."""
    return "\n".join(
        "|".join(
            [
                "eq",
                p["barOpenUtc"],
                _num(p["equity"]),
                _num(p["realizedPnl"]),
                _num(p["unrealizedPnl"]),
                _num(p["openPositions"]),
            ]
        )
        for p in points
    )


def serialize_closed_trades_canonical(positions: Sequence[Mapping]) -> str:
    """Mirror of ``serializeClosedTradesCanonical`` (closed positions only)."""
    rows = []
    for pos in positions:
        if pos["status"] != "closed":
            continue
        exit_ = pos["exit"]
        rows.append(
            "|".join(
                [
                    "trd",
                    pos["positionId"],
                    pos["direction"],
                    pos["entry"]["atUtc"],
                    _num(pos["entry"]["price"]),
                    exit_["atUtc"],
                    _num(exit_["price"]),
                    exit_["reason"],
                    _num(pos["quantityUnits"]),
                    _num(pos["realizedPnl"]),
                    _num(pos["mfePips"]),
                    _num(pos["maePips"]),
                ]
            )
        )
    return "\n".join(rows)
